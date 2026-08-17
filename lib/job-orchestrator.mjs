export const HELPER_VERSION = '3.0.2';

export function googleSerpMode(state = {}, tab = {}) {
  const tabId = Number(tab?.id);
  const openerTabId = Number(tab?.openerTabId);
  if (!Number.isInteger(tabId) || tabId <= 0) return 'idle';

  const affiliateTabs = [state.affiliate_search_root_tab_id, state.affiliate_search_tab_id]
    .map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (state.affiliate_search_session && (affiliateTabs.includes(tabId)
      || affiliateTabs.includes(openerTabId))) return 'affiliate_manual';

  if (state.coupon_command?.kind === 'search') {
    const couponTabId = Number(state.coupon_tab_id);
    if (!Number.isInteger(couponTabId) || couponTabId === tabId) return 'coupon';
  }

  const registry = state.tab_registry;
  const jobId = state.active_job?.job_id;
  const controllerTabId = Number(registry?.controller_tab_id);
  const serpTabId = Number(registry?.serp_tab_id);
  const owned = tabId === controllerTabId || tabId === serpTabId || openerTabId === controllerTabId;
  if (jobId && registry?.job_id === jobId && owned) return 'ads_discovery';
  return 'idle';
}

export function helperPanelView(state = {}, couponState = {}) {
  if (state.affiliate_search_session?.purpose === 'domain_verification') return 'ads';
  if (state.affiliate_application_command || state.affiliate_search_session) return 'affiliate';
  const requested = String(state.helper_context?.mode || 'overview');
  if (['ads', 'traffic', 'coupon', 'affiliate', 'harvester'].includes(requested)) return requested;
  if (couponState.job) return 'coupon';
  if (validateJobIdentity(state.active_job).valid) return 'ads';
  return 'overview';
}

export const SERP_COLLECTION_STAGES = Object.freeze([
  'opening_market', 'scanning_serp', 'waiting_for_persist',
]);

export const POST_SERP_STAGES = Object.freeze([
  'aggregating_domains', 'finding_advertisers', 'opening_transparency',
  'awaiting_manual', 'collecting_portfolio', 'cleaning_tabs', 'completed',
]);

export const TERMINAL_JOB_STATES = Object.freeze([
  'completed', 'partial', 'captcha', 'context_mismatch', 'timeout',
  'disconnected', 'stopped', 'failed',
]);

export function isTerminalJob(job) {
  return Boolean(job && TERMINAL_JOB_STATES.includes(job.status));
}

export function isSerpCollectionStage(job) {
  return Boolean(job && SERP_COLLECTION_STAGES.includes(job.stage) && !isTerminalJob(job));
}

export function isPostSerpStage(job) {
  return Boolean(job && (POST_SERP_STAGES.includes(job.stage)
    || (job.final_batch_acked && job.domains_aggregated)));
}

export function withAnywhereRegion(value = 'https://adstransparency.google.com/') {
  const url = new URL(value, 'https://adstransparency.google.com/');
  url.searchParams.set('region', 'anywhere');
  return url.href;
}

export function adsTransparencyDomainUrl(catcherDomain, presetDate = '7 ngày qua') {
  const domain = String(catcherDomain || '').trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  const url = new URL('https://adstransparency.google.com/');
  url.searchParams.set('region', 'anywhere');
  url.searchParams.set('domain', domain);
  url.searchParams.set('preset-date', presetDate);
  url.searchParams.set('platform', 'SEARCH');
  url.searchParams.set('format', 'TEXT');
  return url.href;
}

export function matchesAdsTransparencyDomainFilter(value, catcherDomain) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'adstransparency.google.com'
      && url.pathname === '/' && url.searchParams.get('region') === 'anywhere'
      && url.searchParams.get('domain') === String(catcherDomain || '').trim().toLowerCase()
      && url.searchParams.get('platform') === 'SEARCH' && url.searchParams.get('format') === 'TEXT';
  } catch {
    return false;
  }
}

export function anywhereRegionNavigation(currentUrl, previousTarget = null) {
  const target = withAnywhereRegion(currentUrl);
  const current = new URL(currentUrl).href;
  if (current === target && new URL(current).searchParams.get('region') === 'anywhere') {
    return { action: 'ready', target };
  }
  if (previousTarget === target) return { action: 'blocked', target };
  return { action: 'redirect', target };
}

export function validateJobIdentity(job, expected = {}) {
  if (!job || !/^adsjob_[a-f0-9]{32}$/.test(String(job.job_id || ''))) {
    return { valid: false, reason: 'invalid_job_id' };
  }
  if (expected.job_id && job.job_id !== expected.job_id) return { valid: false, reason: 'job_mismatch' };
  if (expected.session_id && job.session_id !== expected.session_id) return { valid: false, reason: 'session_mismatch' };
  if (job.stop_requested || job.status === 'stopping' || job.status === 'stopped') return { valid: false, reason: 'stopped' };
  if (isTerminalJob(job)) return { valid: false, reason: 'terminal' };
  return { valid: true, reason: null };
}

export function sequentialSerpPages(total = 5) {
  const count = Math.max(1, Math.min(5, Number(total) || 5));
  return Array.from({ length: count }, (_, index) => index + 1);
}

export function nextSerpPage(current, total = 5, stopRequested = false) {
  if (stopRequested) return null;
  const pages = sequentialSerpPages(total);
  const index = pages.indexOf(Number(current));
  return index >= 0 && index < pages.length - 1 ? pages[index + 1] : null;
}

export function allowedNavigation(url, purpose) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (purpose === 'valentin') return parsed.hostname === 'valentin.app' && parsed.pathname === '/';
    if (purpose === 'serp') return parsed.hostname === 'www.google.com' && parsed.pathname === '/search';
    if (purpose === 'transparency') {
      return parsed.hostname === 'adstransparency.google.com' && (
        parsed.pathname === '/' || /^\/advertiser\/AR\d+(?:\/|$)/.test(parsed.pathname)
      );
    }
    return false;
  } catch {
    return false;
  }
}

export function detectBlockedPage({ url = '', title = '', text = '' } = {}) {
  const haystack = `${url}\n${title}\n${text}`.toLowerCase();
  if (/sorry\/index|unusual traffic|not a robot|captcha/.test(haystack)) return 'captcha';
  return null;
}

export function fallbackProgress(fromMode, toMode) {
  if (fromMode !== 'exact_location' || toMode !== 'country_only') return null;
  return { location_mode: 'country_only', fallback_from: 'exact_location' };
}

export function createOwnedTabRegistry(jobId, hiAutoTabId) {
  return { job_id: jobId, hi_auto_tab_id: hiAutoTabId, controller_tab_id: null, serp_tab_id: null, created_tab_ids: [] };
}

export function registerCreatedTab(registry, role, tabId) {
  const id = Number(tabId);
  if (!registry || !Number.isInteger(id) || id <= 0 || id === Number(registry.hi_auto_tab_id)) {
    throw new Error('Refusing to own an invalid or Hi Auto tab.');
  }
  if (!['controller', 'serp'].includes(role)) throw new Error('Unknown owned tab role.');
  const next = { ...registry, created_tab_ids: [...new Set([...(registry.created_tab_ids || []), id])] };
  next[`${role}_tab_id`] = id;
  return next;
}

export function claimSerpTab(registry, { tab_id: tabId, opener_tab_id: openerTabId } = {}) {
  const id = Number(tabId); const opener = Number(openerTabId);
  if (!registry || !Number.isInteger(id) || id <= 0) return { accepted: false, registry, reason: 'invalid_tab' };
  if (id === Number(registry.hi_auto_tab_id)) return { accepted: false, registry, reason: 'hi_auto_tab' };
  if (id === Number(registry.serp_tab_id) && (registry.created_tab_ids || []).map(Number).includes(id)) {
    return { accepted: true, registry, reason: null };
  }
  if (id === Number(registry.controller_tab_id)) {
    return { accepted: true, registry: { ...registry, serp_tab_id: id }, reason: null };
  }
  if (opener !== Number(registry.controller_tab_id)) return { accepted: false, registry, reason: 'not_job_owned' };
  return { accepted: true, registry: registerCreatedTab(registry, 'serp', id), reason: null };
}

export function ownedTemporaryTabIds(registry) {
  const owned = new Set((registry?.created_tab_ids || []).map(Number));
  owned.delete(Number(registry?.hi_auto_tab_id));
  return [...owned].filter((id) => Number.isInteger(id) && id > 0);
}

export function canCloseOwnedTab(registry, tabId) {
  return ownedTemporaryTabIds(registry).includes(Number(tabId));
}

export function planOwnedTabCleanup(registry, existingTabIds = []) {
  const existing = new Set(existingTabIds.map(Number));
  const owned = ownedTemporaryTabIds(registry);
  return { close: owned.filter((id) => existing.has(id)), already_closed: owned.filter((id) => !existing.has(id)) };
}

export function serpRegistrationDecision(registry, job, senderTabId) {
  if (!registry || !job || registry.job_id !== job.job_id) {
    return { action: 'reject', reason: 'job_mismatch' };
  }
  if (isPostSerpStage(job)) {
    return ownedTemporaryTabIds(registry).includes(Number(senderTabId))
      ? { action: 'stale', reason: 'serp_collection_already_completed' }
      : { action: 'reject', reason: 'not_job_owned' };
  }
  return { action: 'register', reason: null };
}

export function durableSerpReady(job) {
  return Boolean(job?.final_batch_acked && job?.domains_aggregated && Number(job?.current_serp_page) === Number(job?.requested_pages));
}

export function validateAdvertiserProfile(profileUrl, advertiserId) {
  try {
    const parsed = new URL(profileUrl);
    const pathId = parsed.pathname.match(/^\/advertiser\/(AR\d+)\/?$/)?.[1] ?? null;
    return parsed.protocol === 'https:' && parsed.hostname === 'adstransparency.google.com' && pathId === advertiserId;
  } catch {
    return false;
  }
}

export function canonicalAdvertiserProfileUrl(value, expectedAdvertiserId = null) {
  try {
    const parsed = new URL(value);
    const advertiserId = parsed.pathname.match(/^\/advertiser\/(AR\d+)(?:\/|$)/)?.[1] ?? null;
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'adstransparency.google.com'
        || !advertiserId || (expectedAdvertiserId && advertiserId !== expectedAdvertiserId)) return null;
    parsed.pathname = `/advertiser/${advertiserId}`;
    parsed.hash = '';
    parsed.searchParams.set('region', 'anywhere');
    return parsed.href;
  } catch {
    return null;
  }
}

export function chooseAdvertiserCandidate(records = [], catcherDomain = '') {
  const domain = String(catcherDomain || '').trim().toLowerCase();
  const candidates = [];
  for (const record of records) {
    let parsed;
    try { parsed = new URL(record.href, 'https://adstransparency.google.com/'); } catch { continue; }
    const profileUrl = canonicalAdvertiserProfileUrl(parsed.href);
    const advertiserId = profileUrl ? new URL(profileUrl).pathname.match(/^\/advertiser\/(AR\d+)$/)?.[1] : null;
    if (!advertiserId || !validateAdvertiserProfile(profileUrl, advertiserId)) continue;
    const evidence = String(record.evidence || record.text || '').toLowerCase();
    const exactDomain = domain && new RegExp(`(^|[^a-z0-9.-])${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9.-]|$)`, 'i').test(evidence);
    const candidate = { advertiser_id: advertiserId, profile_url: profileUrl, advertiser_name: String(record.text || '').trim() || null, evidence: record.evidence || record.text || '', score: exactDomain ? 100 : 0 };
    const existing = candidates.find((item) => item.advertiser_id === advertiserId);
    if (!existing) candidates.push(candidate);
    else if (candidate.score > existing.score) Object.assign(existing, candidate);
  }
  candidates.sort((a, b) => b.score - a.score || a.advertiser_id.localeCompare(b.advertiser_id));
  if (!candidates.length) return { status: 'no_advertiser_found', candidate: null };
  if (candidates[0].score < 100 || (candidates[1]?.score ?? -1) === candidates[0].score) {
    return { status: 'needs_manual_review', candidate: null, candidates };
  }
  return { status: 'advertiser_found', candidate: candidates[0], candidates };
}

export function collectAdvertiserCandidates(records = [], limit = 50) {
  const candidates = [];
  for (const record of records) {
    const profileUrl = canonicalAdvertiserProfileUrl(record.href);
    const advertiserId = profileUrl
      ? new URL(profileUrl).pathname.match(/^\/advertiser\/(AR\d+)$/)?.[1] : null;
    if (!advertiserId || !validateAdvertiserProfile(profileUrl, advertiserId)) continue;
    if (candidates.some((item) => item.advertiser_id === advertiserId)) continue;
    candidates.push({
      advertiser_id: advertiserId, profile_url: profileUrl,
      advertiser_name: String(record.text || '').trim() || null,
      evidence: record.evidence || record.text || '',
    });
    if (candidates.length >= Math.max(1, Math.min(50, Number(limit) || 50))) break;
  }
  return candidates;
}
