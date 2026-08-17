import { GENERIC_CODE_WORDS, isPlausibleCode, normalizeCode } from './coupon-codes.mjs';

export const HARVESTER_VERSION = 'coupon-harvester/2.1.0';
export const HARVESTER_STORAGE_KEYS = Object.freeze([
  'coupon_harvester_coupons', 'coupon_harvester_settings', 'coupon_harvester_rules',
  'coupon_harvester_active_tabs', 'coupon_harvester_review',
]);

export const DEFAULT_HARVESTER_SETTINGS = Object.freeze({
  text: true, clickdiff: true, clipboard: true, network: true, canvas: true,
  url: true, rules: true, ocr: false, overlay: true,
  allowCodes: [], blockCodes: [], domainOverrides: {},
});

const HARD_BLOCK = new Set([
  ...GENERIC_CODE_WORDS, 'COPY', 'COPIED', 'SHOW', 'REVEAL', 'HERE', 'DETAILS', 'OFF',
  'SUBMIT', 'VIEW', 'MORE', 'NULL', 'UNDEFINED', 'TRUE', 'FALSE', 'USD', 'VND',
  'HTTP', 'HTTPS', 'WWW', 'HTML', 'JSON', 'GET', 'POST',
]);

const METHOD_POINTS = Object.freeze({ clipboard: 50, network: 40, clickdiff: 30, canvas: 20, rule: 45, url: 20, text: 0, ocr: 10 });

export function validateHarvesterCode(raw, { allowCodes = [], blockCodes = [] } = {}) {
  const code = normalizeCode(String(raw ?? '').replace(/^["'“”‘’`]+|["'“”‘’`,.;:!?]+$/gu, ''));
  const allow = new Set(allowCodes.map(normalizeCode));
  const block = new Set(blockCodes.map(normalizeCode));
  if (allow.has(code)) return { valid: true, code };
  if (code.length < 3 || code.length > 32) return { valid: false, code, reason: 'length' };
  const original = String(raw ?? '').trim();
  if (/(?:https?:\/\/|www\.|\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b)/i.test(original)) return { valid: false, code, reason: 'url_or_email' };
  if (/(?:[$€£¥₫]\s*\d|\b\d+(?:[.,]\d{1,2})?\s*(?:USD|EUR|GBP|VND)\b)/i.test(original)) return { valid: false, code, reason: 'money' };
  if (/^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/.test(original)) return { valid: false, code, reason: 'date' };
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(original)) return { valid: false, code, reason: 'color' };
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) return { valid: false, code, reason: 'shape' };
  if (HARD_BLOCK.has(code) || block.has(code) || !isPlausibleCode(code)) return { valid: false, code, reason: 'blocklist' };
  return { valid: true, code };
}

export function scoreHarvesterCandidate(candidate, overrides = {}) {
  const checked = validateHarvesterCode(candidate?.rawCode ?? candidate?.code, overrides);
  if (!checked.valid) return { ...checked, confidence: 0, decision: 'reject', reasons: [`reject:${checked.reason}`] };
  let confidence = 0;
  const reasons = [];
  const add = (points, reason) => { confidence += points; reasons.push(`${points >= 0 ? '+' : ''}${points}:${reason}`); };
  for (const method of new Set(candidate.detectedBy ?? [candidate.method ?? 'text'])) {
    if (METHOD_POINTS[method]) add(METHOD_POINTS[method], method);
  }
  if (candidate.style?.semanticClass || candidate.style?.monospace || candidate.style?.dashedBorder || candidate.style?.highlighted) add(20, 'style');
  if (candidate.explicitLabel) add(20, 'explicit_label');
  if (candidate.nearKeyword) add(15, 'near_keyword');
  if (String(candidate.rawCode ?? candidate.code) === String(candidate.rawCode ?? candidate.code).toUpperCase()) add(10, 'uppercase');
  if (/[A-Z]/.test(checked.code) && /\d/.test(checked.code)) add(5, 'letters_numbers');
  if (Number(candidate.occurrenceCount) > 30) add(-20, 'too_frequent');
  confidence = Math.max(0, Math.min(100, confidence));
  if (candidate.detectedBy?.includes('ocr')) confidence = Math.min(59, confidence);
  return { valid: true, code: checked.code, confidence, decision: confidence >= 60 ? 'auto_save' : confidence >= 35 ? 'review' : 'reject', reasons };
}

function hash(value) {
  let result = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) { result ^= value.charCodeAt(i); result = Math.imul(result, 0x01000193); }
  return (result >>> 0).toString(16).padStart(8, '0');
}

export function couponId(hostname, code) { return `coupon_${hash(`${String(hostname).toLowerCase()}\0${normalizeCode(code)}`)}`; }

export function candidateToCoupon(candidate, score) {
  const now = Number(candidate.lastSeen) || Date.now();
  return {
    id: couponId(candidate.hostname, score.code), code: score.code,
    hostname: String(candidate.hostname ?? '').toLowerCase(), sourceUrl: candidate.sourceUrl,
    offerTitle: candidate.offerTitle ?? '', description: String(candidate.description ?? candidate.context ?? '').slice(0, 300),
    conditions: candidate.conditions ?? '', expiresAt: candidate.expiresAt ?? null,
    confidence: score.confidence, detectedBy: [...new Set(candidate.detectedBy ?? [])],
    firstSeen: Number(candidate.firstSeen) || now, lastSeen: now, verified: Boolean(candidate.verified),
    ...(candidate.screenshotCrop ? { screenshotCrop: candidate.screenshotCrop } : {}),
  };
}

export function mergeHarvesterCoupons(existing, incoming) {
  const byId = new Map((existing ?? []).map((coupon) => [coupon.id, coupon]));
  for (const coupon of incoming ?? []) {
    const prior = byId.get(coupon.id);
    if (!prior) { byId.set(coupon.id, coupon); continue; }
    byId.set(coupon.id, {
      ...prior,
      offerTitle: coupon.offerTitle?.length > prior.offerTitle?.length ? coupon.offerTitle : prior.offerTitle,
      description: coupon.description?.length > prior.description?.length ? coupon.description : prior.description,
      conditions: coupon.conditions?.length > prior.conditions?.length ? coupon.conditions : prior.conditions,
      expiresAt: prior.expiresAt ?? coupon.expiresAt, confidence: Math.max(prior.confidence, coupon.confidence),
      detectedBy: [...new Set([...(prior.detectedBy ?? []), ...(coupon.detectedBy ?? [])])],
      firstSeen: Math.min(prior.firstSeen, coupon.firstSeen), lastSeen: Math.max(prior.lastSeen, coupon.lastSeen),
      verified: prior.verified || coupon.verified, screenshotCrop: prior.screenshotCrop ?? coupon.screenshotCrop,
    });
  }
  return [...byId.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 1000);
}

export function harvesterCouponToBlock(coupon) {
  const rank = ['clipboard', 'network', 'clickdiff', 'rule', 'canvas', 'url', 'text', 'ocr'];
  const method = rank.find((value) => coupon.detectedBy?.includes(value)) ?? 'labelled_text';
  return {
    code: coupon.code,
    method: method === 'text' ? 'labelled_text' : method,
    label: coupon.detectedBy?.join('+') ?? null,
    context_text: coupon.description || coupon.offerTitle || '',
    in_coupon_component: coupon.confidence >= 35,
    offer_text: coupon.offerTitle || coupon.description || null,
    expiry: coupon.expiresAt ?? null,
  };
}

export function normalizeRule(rule) {
  if (!rule?.hostname || !rule?.codeSelector) throw new Error('Rule cần hostname và codeSelector.');
  const selector = String(rule.codeSelector).slice(0, 500);
  if (/[<>]|javascript:/i.test(selector)) throw new Error('Selector không hợp lệ.');
  return {
    id: rule.id ?? `rule_${hash(`${rule.hostname}\0${selector}`)}`,
    hostname: String(rule.hostname).toLowerCase(), offerSelector: String(rule.offerSelector ?? '').slice(0, 500),
    codeSelector: selector, revealSelector: String(rule.revealSelector ?? '').slice(0, 500),
    descSelector: String(rule.descSelector ?? '').slice(0, 500), source: rule.source ?? 'learned',
    stale: Boolean(rule.stale), staleReason: rule.staleReason ?? null, updatedAt: Number(rule.updatedAt) || Date.now(),
  };
}
