import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canUseSuggestionKeyboardFallback, dispatchExactSuggestionKeyboardFallback,
  dispatchSuggestionInteraction, discoverSuggestionCandidates, exactSuggestionDecision, fillSearchInput,
  registrableSuggestionDomain, shouldRescanDetachedSuggestion, waitForExactSuggestion,
} from './autocomplete-orchestrator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'ads-transparency-autocomplete.json'), 'utf8'));

class FakeEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}

class FakeInput {
  constructor() {
    this.events = [];
    this.ownerDocument = { defaultView: { HTMLInputElement: FakeInput, Event: FakeEvent, KeyboardEvent: FakeEvent } };
  }
  dispatchEvent(event) { this.events.push(event.type === 'keydown' || event.type === 'keyup' ? `${event.type}:${event.key}` : event.type); return true; }
}
Object.defineProperty(FakeInput.prototype, 'value', { set(value) { this.currentValue = value; }, get() { return this.currentValue; } });

function fakeClickable({ connected = true } = {}) {
  const events = [];
  const element = {
    isConnected: connected, hidden: false, parentNode: null, events,
    ownerDocument: { defaultView: { MouseEvent: FakeEvent, PointerEvent: FakeEvent } },
    getAttribute: () => null, getClientRects: () => connected ? [{}] : [],
    scrollIntoView: () => events.push('scroll'), focus: () => events.push('focus'),
    dispatchEvent: (event) => { events.push(event.type); return true; },
  };
  return element;
}

test('native input setter fills the exact catcher domain and dispatches input/change', () => {
  const input = new FakeInput();
  fillSearchInput(input, fixture.target);
  assert.equal(input.value, fixture.target);
  assert.deepEqual(input.events, ['input', 'change']);
});

test('bounded waiting finds a suggestion that renders late', async () => {
  let scans = 0;
  const decision = await waitForExactSuggestion({
    catcherDomain: fixture.target, timeoutMs: 300, pollMs: 20,
    root: {}, observerFactory: null,
    scan: () => (++scans < 3 ? [] : fixture.unique_exact),
  });
  assert.equal(decision.status, 'unique');
  assert.ok(scans >= 3);
});

test('only one exact registrable-domain suggestion is selected', () => {
  assert.equal(registrableSuggestionDomain('https://offers.wizza.com/store/a?q=1'), 'wizza.com');
  const decision = exactSuggestionDecision(fixture.unique_exact, fixture.target);
  assert.equal(decision.status, 'unique');
  assert.equal(decision.candidate.href, 'https://wizza.com/store/ftuk');
  assert.equal(exactSuggestionDecision(fixture.near_only, fixture.target).status, 'missing');
});

test('ambiguous exact candidates pause and helper overlay evidence is excluded', () => {
  assert.equal(exactSuggestionDecision(fixture.ambiguous_exact, fixture.target).status, 'ambiguous');
  const withoutOverlay = exactSuggestionDecision(fixture.overlay_and_exact, fixture.target);
  assert.equal(withoutOverlay.status, 'unique');
  assert.equal(withoutOverlay.candidates.length, 1);
});

test('semantic discovery traverses an open shadow root, excludes overlay and collapses nested items', () => {
  const docView = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  const makeNode = (props = {}) => ({
    isConnected: true, hidden: false, parentNode: null, ownerDocument: { defaultView: docView },
    children: [], getAttribute: () => null, getClientRects: () => [{}],
    matches: () => false, querySelector: () => null, querySelectorAll: () => [],
    contains(other) { let node = other?.parentNode; while (node) { if (node === this) return true; node = node.parentNode; } return false; },
    ...props,
  });
  const helper = makeNode({ id: 'discovery-helper' });
  const overlay = makeNode({ innerText: 'wizza.com', textContent: 'wizza.com', parentNode: helper });
  const shadow = { mode: 'open', host: null, querySelectorAll: () => [] };
  const popup = makeNode(); popup.parentNode = shadow;
  const option = makeNode({
    innerText: 'Wizza advertiser — wizza.com', textContent: 'Wizza advertiser — wizza.com',
    matches: (selector) => selector.includes('[role="option"]'),
  });
  const innerLink = makeNode({ href: 'https://wizza.com/', innerText: 'wizza.com', textContent: 'wizza.com', matches: (selector) => selector.includes('a[href]') });
  option.parentNode = popup; innerLink.parentNode = option; option.children = [innerLink]; popup.children = [option];
  popup.querySelectorAll = (selector) => selector === '[role="option"], [role="listitem"], a[href], button, li' ? [option, innerLink] : [];
  const host = makeNode({ shadowRoot: shadow }); shadow.host = host;
  shadow.querySelectorAll = (selector) => {
    if (selector === '*') return [popup, option, innerLink];
    if (selector === '[role="option"]') return [option];
    if (selector === '[role="listbox"]') return [popup];
    return [];
  };
  const root = {
    querySelectorAll(selector) {
      if (selector === '*') return [helper, overlay, host];
      if (selector === '[role="option"]') return [overlay];
      return [];
    },
  };
  const found = discoverSuggestionCandidates(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].domains[0], 'wizza.com');
  assert.equal(found[0].element, option);
});

test('real suggestion interaction dispatches the compatible pointer/mouse sequence', () => {
  const element = fakeClickable();
  assert.equal(dispatchSuggestionInteraction(element).clicked, true);
  assert.deepEqual(element.events, ['scroll', 'focus', 'pointerdown', 'mousedown', 'mouseup', 'click']);
  assert.equal(dispatchSuggestionInteraction(fakeClickable({ connected: false })).clicked, false);
});

test('detached suggestion is rescanned at most once', () => {
  assert.equal(shouldRescanDetachedSuggestion({ detached: true, rescanUsed: false }), true);
  assert.equal(shouldRescanDetachedSuggestion({ detached: true, rescanUsed: true }), false);
  assert.equal(shouldRescanDetachedSuggestion({ detached: false, rescanUsed: false }), false);
});

test('keyboard fallback is guarded by one exact suggestion and runs ArrowDown plus Enter once', () => {
  const unique = exactSuggestionDecision(fixture.unique_exact, fixture.target);
  const ambiguous = exactSuggestionDecision(fixture.ambiguous_exact, fixture.target);
  assert.equal(canUseSuggestionKeyboardFallback(unique, false), true);
  assert.equal(canUseSuggestionKeyboardFallback(ambiguous, false), false);
  assert.equal(canUseSuggestionKeyboardFallback(unique, true), false);
  const input = new FakeInput();
  dispatchExactSuggestionKeyboardFallback(input);
  assert.deepEqual(input.events, [
    'keydown:ArrowDown', 'keyup:ArrowDown', 'keydown:Enter', 'keyup:Enter',
  ]);
});

test('automatic source waits for exact suggestion selection before advertiser results', () => {
  const source = readFileSync(join(here, '..', 'content', 'ads-transparency.js'), 'utf8');
  const automatic = source.indexOf('const suggestion = await autocomplete.waitForExactSuggestion');
  const selected = source.indexOf('const selection = await selectExactSuggestion', automatic);
  const results = source.indexOf('await waitForSearchOutcome(Date.now() + ADVERTISER_RESULT_TIMEOUT_MS)', selected);
  assert.ok(automatic >= 0 && selected > automatic && results > selected);
  assert.match(source, /finishAutomatic\('suggestion_click_failed'/);
  assert.match(source, /finishAutomatic\('needs_manual_review'/);
  assert.match(source, /onlyMissingLegalName \? 'profile_review_skipped' : 'needs_manual_review'/);
  assert.doesNotMatch(source.slice(automatic, selected), /KeyboardEvent|key:\s*'Enter'/);
  assert.doesNotMatch(source, /cleanupOwnedTabs|finishAndCleanup/);
});

test('advertiser result reader waits for a fresh stable page before deciding', () => {
  const source = readFileSync(join(here, '..', 'content', 'ads-transparency.js'), 'utf8');
  assert.match(source, /ADVERTISER_RESULT_TIMEOUT_MS = 15_000/);
  assert.match(source, /FILTER_MIN_DWELL_MS = 6_000/);
  assert.match(source, /RESULT_MIN_DWELL_MS = 5_000/);
  assert.match(source, /RESULT_STABLE_MS = 2_500/);
  assert.match(source, /EMPTY_MIN_DWELL_MS = 8_000/);
  assert.match(source, /candidateSignature/);
  assert.match(source, /waitForSearchOutcome\(Date\.now\(\) \+ ADVERTISER_RESULT_TIMEOUT_MS\)/);
  assert.doesNotMatch(source, /selection\.effect\.links\?\.length \|\| selection\.effect\.empty/);
  assert.doesNotMatch(source, /candidates\.length && Date\.now\(\) - stableSince >= 1200/);
});

test('resume reconciles the current owned search tab before safe root fallback', () => {
  const content = readFileSync(join(here, '..', 'content', 'ads-transparency.js'), 'utf8');
  const worker = readFileSync(join(here, '..', 'service-worker.js'), 'utf8');
  assert.match(content, /RESUME_AUTOMATIC_ADVERTISER/);
  assert.match(content, /const existingLinks = advertiserLinks\(\)/);
  assert.ok(content.indexOf('const existingLinks = advertiserLinks()') < content.indexOf("ui.status(root, 'Đang nhập domain')"));
  assert.match(worker, /resumed_in_place: true/);
  assert.match(worker, /Old content scripts or unusable SPA state fall back to one safe root navigation/);
});

test('manual catcher research accumulates visible profiles until explicit confirmation', () => {
  const content = readFileSync(join(here, '..', 'content', 'ads-transparency.js'), 'utf8');
  const worker = readFileSync(join(here, '..', 'service-worker.js'), 'utf8');
  const manualStart = content.indexOf('const runCatcherResearch = async');
  const automaticStart = content.indexOf('const runAutomatic = async');
  const manual = content.slice(manualStart, automaticStart);
  assert.match(content, /const runCatcherResearch = async/);
  assert.match(content, /RESUME_CATCHER_RESEARCH/);
  assert.match(content, /await executeCatcherResearch\(\)/);
  assert.match(manual, /new MutationObserver\(scan\)/);
  assert.match(manual, /UPDATE_CATCHER_RESEARCH_SCAN/);
  assert.match(manual, /CONFIRM_CATCHER_RESEARCH_SCAN/);
  assert.match(manual, /Xác nhận kết quả/);
  assert.doesNotMatch(manual, /NAVIGATE_CATCHER_PROFILE|SET_ADVERTISER_PROFILE_BATCH|waitForSearchOutcome/);
  assert.doesNotMatch(manual, /chrome\.tabs\.update|CLOSE_LEGACY_WORK_TAB/);
  assert.match(worker, /chrome\.tabs\.sendMessage\(tab\.id, \{ type: 'RESUME_CATCHER_RESEARCH' \}\)/);
  assert.match(worker, /newly stored command would never/);
  assert.match(worker, /manual_profiles: \[\]/);
  assert.match(worker, /manual_ads_transparency_confirmation/);
  assert.match(worker, /tab_kept_open: true/);
});

test('domain filter collects every profile and advances a durable sequential batch', () => {
  const content = readFileSync(join(here, '..', 'content', 'ads-transparency.js'), 'utf8');
  const worker = readFileSync(join(here, '..', 'service-worker.js'), 'utf8');
  assert.match(content, /matchesAdsTransparencyDomainFilter/);
  assert.match(content, /collectAdvertiserCandidates\(advertiserLinks\(\), 50\)/);
  assert.match(content, /SET_ADVERTISER_PROFILE_BATCH/);
  assert.match(content, /ADVERTISER_BATCH_PROFILE_SAVED/);
  assert.match(content, /defer_catcher_completion: Boolean\(batchCommand\)/);
  assert.match(worker, /profile_queue: profiles, profile_index: 0/);
  assert.match(worker, /profile_index: index \+ 1/);
  assert.match(worker, /ads_transparency_domain_filter/);
});

test('manual catcher and portfolio confirmation keep Ads Transparency open', () => {
  const content = readFileSync(join(here, '..', 'content', 'ads-transparency.js'), 'utf8');
  const worker = readFileSync(join(here, '..', 'service-worker.js'), 'utf8');
  const manualStart = content.indexOf('const runCatcherResearch = async');
  const automaticStart = content.indexOf('const runAutomatic = async');
  assert.doesNotMatch(content.slice(manualStart, automaticStart), /CLOSE_LEGACY_WORK_TAB/);
  const portfolioStart = content.indexOf('const startManualPortfolioScan = async');
  const finishAutomatic = content.indexOf('const finishAutomatic = async');
  const portfolio = content.slice(portfolioStart, finishAutomatic);
  assert.doesNotMatch(portfolio, /MutationObserver|setInterval\(scan|await scan\(\);/);
  assert.match(portfolio, /UPDATE_PORTFOLIO_SCAN/);
  assert.match(portfolio, /CONFIRM_PORTFOLIO_SCAN/);
  assert.match(portfolio, /manualCreativeCollection/);
  assert.match(portfolio, /1 · Quét hiện trạng/);
  assert.match(portfolio, /2 · Xác nhận & OCR/);
  assert.ok(portfolio.indexOf("scanButton.addEventListener('click'")
    < portfolio.indexOf("confirmButton.addEventListener('click'"));
  assert.doesNotMatch(portfolio, /CLOSE_LEGACY_WORK_TAB|profileButton\.click|collectButton\.click/);
  assert.match(content, /if \(portfolioCommand\) await startManualPortfolioScan\(portfolioCommand\)/);
  assert.match(worker, /manual_creatives: \[\]/);
  assert.match(worker, /manual_snapshot_taken: false/);
  assert.match(worker, /manual_snapshot_taken: Boolean\(message\.snapshot_taken\)/);
  assert.match(worker, /manual_portfolio_result/);
  assert.match(worker, /Number\(saved\.work_tab_id\) !== candidate/);
  assert.match(worker, /Number\(saved\.local_tab_id\) === candidate/);
  assert.match(worker, /canCloseOwnedTab\(saved\.tab_registry, candidate\)/);
  assert.match(worker, /closeLegacyWorkTab\(sender\.tab\.id\)/);
});

test('creative detail is redirected through the validated advertiser breadcrumb profile', () => {
  const content = readFileSync(join(here, '..', 'content', 'ads-transparency.js'), 'utf8');
  const automatic = content.indexOf('const runAutomatic = async');
  const creative = content.indexOf('creative_detail_canonicalized_to_advertiser_profile', automatic);
  const saving = content.indexOf('ui.status(root, `Đang lưu advertiser ${advertiserCommand', creative);
  assert.match(content, /creative_detail_canonicalized_to_advertiser_profile/);
  assert.match(content, /canonicalAdvertiserProfileUrl\(location\.href, advertiserCommand\.advertiser_id\)/);
  assert.ok(automatic >= 0 && creative > automatic && saving > creative);
});
