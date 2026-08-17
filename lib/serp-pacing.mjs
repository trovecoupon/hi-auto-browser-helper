export const SERP_LOAD_TIMEOUT_MS = 12_000;
export const SERP_DOM_TIMEOUT_MS = 15_000;
export const SERP_DOM_POLL_MS = 300;
export const SERP_DOM_STABLE_MS = 1_200;
export const SERP_MIN_PAGE_DWELL_MS = 3_500;
export const SERP_MAX_PAGE_DWELL_MS = 5_500;

function boundedRandom(random) {
  const value = Number(random?.());
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 0.999999)) : 0.5;
}

export function serpPageDwellMs(random = Math.random) {
  return Math.round(SERP_MIN_PAGE_DWELL_MS
    + boundedRandom(random) * (SERP_MAX_PAGE_DWELL_MS - SERP_MIN_PAGE_DWELL_MS));
}

export function serpSnapshotSignature(parsed = {}) {
  const ads = (parsed.ads || []).map((item) => String(item.parser_fingerprint
    || [item.headline, item.display_domain, item.landing_url, item.placement].join('|'))).sort();
  const dropped = (parsed.dropped || []).map((item) => String(item.reason_code || '')).sort();
  return JSON.stringify({ status: parsed.status || 'complete', ads, dropped,
    input_count: Number(parsed.input_count || 0) });
}

export function nextSerpStability(previous, parsed, now = Date.now()) {
  const signature = serpSnapshotSignature(parsed);
  const same = previous?.signature === signature;
  const stableSince = same ? Number(previous.stable_since || now) : now;
  return {
    signature,
    stable_since: stableSince,
    stable: parsed?.status === 'complete' && same && now - stableSince >= SERP_DOM_STABLE_MS,
  };
}
