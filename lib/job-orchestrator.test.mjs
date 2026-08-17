import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adsTransparencyDomainUrl, allowedNavigation, anywhereRegionNavigation, canCloseOwnedTab,
  canonicalAdvertiserProfileUrl, chooseAdvertiserCandidate, claimSerpTab,
  collectAdvertiserCandidates,
  createOwnedTabRegistry, detectBlockedPage, durableSerpReady, fallbackProgress,
  googleSerpMode, helperPanelView, nextSerpPage, ownedTemporaryTabIds, planOwnedTabCleanup, registerCreatedTab, sequentialSerpPages,
  serpRegistrationDecision, validateAdvertiserProfile, validateJobIdentity, withAnywhereRegion,
  matchesAdsTransparencyDomainFilter,
} from './job-orchestrator.mjs';
import { parseSerpHtml, validateGoogleSerpContext } from './parsers.mjs';
import { FrameSnapshotCache } from './frame-coordinator.mjs';

const session = { query: 'the5ers promo code', country_code: 'US', language_code: 'en', serp_pages: 5, device: 'desktop', location_mode: 'country_only' };

test('SERP orchestration is sequential 1-5 and stop prevents next navigation', () => {
  assert.deepEqual(sequentialSerpPages(5), [1, 2, 3, 4, 5]);
  assert.equal(nextSerpPage(1, 5, false), 2);
  assert.equal(nextSerpPage(5, 5, false), null);
  assert.equal(nextSerpPage(2, 5, true), null);
});

test('Google SERP mode is explicit and affiliate search always stays manual', () => {
  const affiliate = {
    affiliate_search_session: { candidate_id: 7 },
    affiliate_search_root_tab_id: 40,
    affiliate_search_tab_id: 41,
  };
  assert.equal(googleSerpMode(affiliate, { id: 40 }), 'affiliate_manual');
  assert.equal(googleSerpMode(affiliate, { id: 42, openerTabId: 41 }), 'affiliate_manual');
  assert.equal(googleSerpMode({ coupon_command: { kind: 'search' }, coupon_tab_id: 50 }, { id: 50 }), 'coupon');
  const ads = {
    active_job: { job_id: 'ads-1' },
    tab_registry: { job_id: 'ads-1', controller_tab_id: 60, serp_tab_id: 61 },
  };
  assert.equal(googleSerpMode(ads, { id: 61 }), 'ads_discovery');
  assert.equal(googleSerpMode(ads, { id: 62, openerTabId: 60 }), 'ads_discovery');
  assert.equal(googleSerpMode(ads, { id: 99 }), 'idle');
  assert.equal(googleSerpMode({}, { id: 70 }), 'idle');
});

test('Side Panel follows the explicit Hi Auto task and never defaults to Coupon', () => {
  assert.equal(helperPanelView({}, {}), 'overview');
  assert.equal(helperPanelView({ helper_context: { mode: 'affiliate' } }, {
    candidates: [{ status: 'discovered' }],
  }), 'affiliate');
  assert.equal(helperPanelView({ helper_context: { mode: 'ads' } }, {}), 'ads');
  assert.equal(helperPanelView({ helper_context: { mode: 'harvester' } }, {}), 'harvester');
  assert.equal(helperPanelView({}, { job: { job_id: 'coupon-1' } }), 'coupon');
  assert.equal(helperPanelView({ affiliate_search_session: { candidate_id: 4 },
    helper_context: { mode: 'coupon' } }, { job: { job_id: 'coupon-1' } }), 'affiliate');
  assert.equal(helperPanelView({ affiliate_search_session: { purpose: 'domain_verification',
    project_id: 'project_1' }, helper_context: { mode: 'coupon' } }, {}), 'ads');
});

test('paid top and bottom are kept while organic is dropped', () => {
  const parsed = parseSerpHtml(`
    <article data-discovery-result="paid" data-placement="top" data-landing-url="https://wizza.com/store/a"><a href="https://wizza.com/store/a"></a><span data-field="headline">Top coupon</span><span data-field="display-url">wizza.com</span></article>
    <section data-discovery-result="organic"><a href="https://merchant.example/"></a><span data-field="headline">Organic result</span><span data-field="display-url">merchant.example</span></section>
    <article data-discovery-result="paid" data-placement="bottom" data-landing-url="https://offers.example/deal"><a href="https://offers.example/deal"></a><span data-field="headline">Bottom promo</span><span data-field="display-url">offers.example</span></article>
  `, { ...session, source_url: 'https://www.google.com/search?q=the5ers+promo+code&gl=US&hl=en&start=0' });
  assert.deepEqual(parsed.ads.map((item) => item.placement), ['top', 'bottom']);
  assert.equal(parsed.dropped.length, 1);
  assert.equal(parsed.dropped[0].reason_code, 'non_paid_organic');
});

test('context mismatch, CAPTCHA, allowlist and country fallback are explicit', () => {
  assert.equal(validateGoogleSerpContext('https://www.google.com/search?q=wrong&gl=US&hl=en&start=0', session, 1).valid, false);
  assert.equal(detectBlockedPage({ url: 'https://www.google.com/sorry/index' }), 'captcha');
  assert.equal(allowedNavigation('https://www.google.com/search?q=x', 'serp'), true);
  assert.equal(allowedNavigation('https://evil.example/search?q=x', 'serp'), false);
  assert.equal(allowedNavigation('https://adstransparency.google.com/advertiser/AR123', 'transparency'), true);
  assert.equal(allowedNavigation('https://adstransparency.google.com/advertiser/not-an-id', 'transparency'), false);
  assert.deepEqual(fallbackProgress('exact_location', 'country_only'), { location_mode: 'country_only', fallback_from: 'exact_location' });
});

test('job/session identity rejects mixed, stopped and terminal documents', () => {
  const job = { job_id: `adsjob_${'a'.repeat(32)}`, session_id: 's1', status: 'running', stop_requested: false };
  assert.equal(validateJobIdentity(job, { session_id: 's1' }).valid, true);
  assert.equal(validateJobIdentity(job, { session_id: 's2' }).reason, 'session_mismatch');
  assert.equal(validateJobIdentity({ ...job, stop_requested: true }).reason, 'stopped');
  assert.equal(validateJobIdentity({ ...job, status: 'timeout' }).reason, 'terminal');
});

test('document reload replaces its frame revision without mixing advertiser snapshots', () => {
  const cache = new FrameSnapshotCache();
  const profile = 'https://adstransparency.google.com/advertiser/AR123?region=anywhere';
  cache.accept(7, { frame_id: 1, document_identity: 'doc_first_1234', frame_url: 'https://www.google.com/ad', parent_url: profile, advertiser_id: 'AR123', sequence: 1, content_fingerprint: 'one', headline: 'Old headline' });
  cache.accept(7, { frame_id: 1, document_identity: 'doc_second_5678', frame_url: 'https://www.google.com/ad', parent_url: profile, advertiser_id: 'AR123', sequence: 1, content_fingerprint: 'two', headline: 'New headline' });
  const rows = cache.get(7, profile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].headline, 'New headline');
  assert.equal(cache.get(7, 'https://adstransparency.google.com/advertiser/AR999?region=anywhere').length, 0);
  assert.equal(cache.get(7, 'https://adstransparency.google.com/advertiser/AR123?region=VN').length, 1);
});

test('automatic Ads Transparency URLs always use anywhere without a reload loop', () => {
  assert.equal(withAnywhereRegion('https://adstransparency.google.com/'), 'https://adstransparency.google.com/?region=anywhere');
  assert.equal(withAnywhereRegion('https://adstransparency.google.com/advertiser/AR123?region=VN&platform=SEARCH'),
    'https://adstransparency.google.com/advertiser/AR123?region=anywhere&platform=SEARCH');
  assert.equal(withAnywhereRegion('https://adstransparency.google.com/advertiser/AR123?platform=SEARCH'),
    'https://adstransparency.google.com/advertiser/AR123?platform=SEARCH&region=anywhere');
  const first = anywhereRegionNavigation('https://adstransparency.google.com/?region=VN');
  assert.deepEqual(first, { action: 'redirect', target: 'https://adstransparency.google.com/?region=anywhere' });
  assert.equal(anywhereRegionNavigation('https://adstransparency.google.com/?region=VN', first.target).action, 'blocked');
  assert.equal(anywhereRegionNavigation(first.target, first.target).action, 'ready');
});

test('domain-filtered Ads Transparency URL is exact and bounded to SEARCH text ads', () => {
  const url = adsTransparencyDomainUrl('EDUNEWS.CO.IN');
  assert.equal(url, 'https://adstransparency.google.com/?region=anywhere&domain=edunews.co.in&preset-date=7+ng%C3%A0y+qua&platform=SEARCH&format=TEXT');
  assert.equal(matchesAdsTransparencyDomainFilter(url, 'edunews.co.in'), true);
  assert.equal(matchesAdsTransparencyDomainFilter(url, 'other.example'), false);
  assert.equal(adsTransparencyDomainUrl('not a domain'), null);
});

test('tab ownership closes only the two job-created tabs and never Hi Auto or pre-existing tabs', () => {
  let registry = createOwnedTabRegistry('adsjob_' + 'b'.repeat(32), 10);
  registry = registerCreatedTab(registry, 'controller', 20);
  const rejected = claimSerpTab(registry, { tab_id: 30, opener_tab_id: 99 });
  assert.equal(rejected.accepted, false);
  const claimed = claimSerpTab(registry, { tab_id: 30, opener_tab_id: 20 });
  assert.equal(claimed.accepted, true);
  registry = claimed.registry;
  assert.deepEqual(ownedTemporaryTabIds(registry), [20, 30]);
  assert.equal(canCloseOwnedTab(registry, 10), false);
  assert.equal(canCloseOwnedTab(registry, 99), false);
  assert.equal(canCloseOwnedTab(registry, 20), true);
  assert.deepEqual(planOwnedTabCleanup(registry, [10, 20, 99]), { close: [20], already_closed: [30] });
});

test('success and stop cleanup both close exactly the two job-owned temporary tabs', () => {
  let registry = createOwnedTabRegistry('adsjob_' + 'c'.repeat(32), 10);
  registry = registerCreatedTab(registry, 'controller', 20);
  registry = claimSerpTab(registry, { tab_id: 30, opener_tab_id: 20 }).registry;
  const openTabs = [10, 20, 30, 99];
  const successPlan = planOwnedTabCleanup(registry, openTabs);
  const stoppedPlan = planOwnedTabCleanup(registry, openTabs);
  assert.deepEqual(successPlan, { close: [20, 30], already_closed: [] });
  assert.deepEqual(stoppedPlan, successPlan);
  assert.equal(successPlan.close.includes(10), false);
  assert.equal(successPlan.close.includes(99), false);
});

test('late owned SERP registration is stale while a foreign tab remains rejected', () => {
  let registry = createOwnedTabRegistry('adsjob_' + 'd'.repeat(32), 10);
  registry = registerCreatedTab(registry, 'controller', 20);
  registry = claimSerpTab(registry, { tab_id: 30, opener_tab_id: 20 }).registry;
  const job = { job_id: registry.job_id, status: 'running', stage: 'finding_advertisers', final_batch_acked: true, domains_aggregated: true };
  assert.deepEqual(serpRegistrationDecision(registry, job, 30), { action: 'stale', reason: 'serp_collection_already_completed' });
  assert.deepEqual(serpRegistrationDecision(registry, job, 99), { action: 'reject', reason: 'not_job_owned' });
});

test('SERP final navigation is gated by final batch and domain ACKs', () => {
  const base = { current_serp_page: 5, requested_pages: 5 };
  assert.equal(durableSerpReady({ ...base, final_batch_acked: false, domains_aggregated: false }), false);
  assert.equal(durableSerpReady({ ...base, final_batch_acked: true, domains_aggregated: false }), false);
  assert.equal(durableSerpReady({ ...base, final_batch_acked: true, domains_aggregated: true }), true);
});

test('advertiser candidate requires one exact-domain evidence match and strict profile identity', () => {
  const profile = 'https://adstransparency.google.com/advertiser/AR02096954062137196545';
  const creative = `${profile}/creative/CR08046004961378566145?region=anywhere`;
  assert.equal(validateAdvertiserProfile(profile, 'AR02096954062137196545'), true);
  assert.equal(validateAdvertiserProfile(creative, 'AR02096954062137196545'), false);
  assert.equal(canonicalAdvertiserProfileUrl(creative, 'AR02096954062137196545'), `${profile}?region=anywhere`);
  assert.equal(canonicalAdvertiserProfileUrl(creative, 'AR999'), null);
  assert.equal(validateAdvertiserProfile('http://adstransparency.google.com/advertiser/AR1', 'AR1'), false);
  assert.equal(validateAdvertiserProfile('https://fake.example/advertiser/AR1', 'AR1'), false);
  assert.equal(validateAdvertiserProfile(profile, 'AR999'), false);
  const selected = chooseAdvertiserCandidate([{ href: profile, text: 'Nutrl, Inc.', evidence: 'Search result for wizza.com' }], 'wizza.com');
  assert.equal(selected.status, 'advertiser_found');
  assert.equal(selected.candidate.advertiser_id, 'AR02096954062137196545');
  const selectedFromCreative = chooseAdvertiserCandidate([{ href: creative, text: 'Nutrl, Inc.', evidence: 'Search result for wizza.com' }], 'wizza.com');
  assert.equal(selectedFromCreative.status, 'advertiser_found');
  assert.equal(selectedFromCreative.candidate.profile_url, `${profile}?region=anywhere`);
  assert.equal(chooseAdvertiserCandidate([{ href: profile, text: 'Nutrl, Inc.', evidence: 'unrelated' }], 'wizza.com').status, 'needs_manual_review');
});

test('filtered result collection keeps every unique strict advertiser profile in order', () => {
  const a = 'https://adstransparency.google.com/advertiser/AR111';
  const b = 'https://adstransparency.google.com/advertiser/AR222/creative/CR9?region=VN';
  const candidates = collectAdvertiserCandidates([
    { href: a, text: 'One' }, { href: a, text: 'Duplicate' },
    { href: b, text: 'Two' }, { href: 'https://evil.example/advertiser/AR333', text: 'Bad' },
  ]);
  assert.deepEqual(candidates.map((item) => item.advertiser_id), ['AR111', 'AR222']);
  assert.equal(candidates[1].profile_url, 'https://adstransparency.google.com/advertiser/AR222?region=anywhere');
});
