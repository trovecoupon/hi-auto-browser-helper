export const TRAFFIC_BATCH_SIZE = 8;
export const TRAFFIC_POLL_MIN_MS = 700;
export const TRAFFIC_POLL_MAX_MS = 1200;
// The browser checker has been observed throttling around 100 real searches/hour.
// Forty seconds is a hard ceiling of 90 submissions/hour; jitter keeps the browser
// cadence natural and the page-render time lowers the practical rate further.
export const TRAFFIC_DOMAIN_MIN_MS = 40000;
export const TRAFFIC_DOMAIN_MAX_MS = 50000;
export const TRAFFIC_RATE_COOLDOWN_MS = 60 * 60 * 1000;

function boundedRandom(random) {
  const value = Number(random?.());
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 0.999999)) : 0.5;
}

export function trafficPollDelayMs(random = Math.random) {
  return Math.round(TRAFFIC_POLL_MIN_MS
    + boundedRandom(random) * (TRAFFIC_POLL_MAX_MS - TRAFFIC_POLL_MIN_MS));
}

export function trafficDomainDelayMs(random = Math.random) {
  return Math.round(TRAFFIC_DOMAIN_MIN_MS
    + boundedRandom(random) * (TRAFFIC_DOMAIN_MAX_MS - TRAFFIC_DOMAIN_MIN_MS));
}

export function trafficWaitMs(nextAllowedAt, now = Date.now()) {
  const target = Number(nextAllowedAt);
  const current = Number(now);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.ceil(target - current));
}

export function isTrafficRateReason(reason) {
  return ['rate_limited', 'rate_limited_or_quota'].includes(String(reason || ''));
}
