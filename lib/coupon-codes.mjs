/**
 * Lõi thuần của Coupon Discovery: chuẩn hoá mã, chặn false-positive, đối chiếu merchant, chấm độ tin,
 * gộp trùng. KHÔNG chạm DOM, KHÔNG chạm mạng — nhận object thuần nên test được offline.
 *
 * Nguyên tắc: KHÔNG bịa coupon từ offer text. Một chuỗi viết hoa chỉ thành ứng viên khi có BẰNG CHỨNG
 * cấu trúc (nhãn, nút reveal, data-*, JSON-LD). Không có bằng chứng thì loại, không đoán.
 */

export const COUPON_PARSER_VERSION = 'coupon-discovery/2.0.0';

export const COUPON_ERROR_CODES = Object.freeze({
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  PAGE_CHANGED: 'PAGE_CHANGED',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  WRONG_MERCHANT: 'WRONG_MERCHANT',
  NO_RESULTS: 'NO_RESULTS',
  RATE_LIMITED: 'RATE_LIMITED',
  PERMISSION_MISSING: 'PERMISSION_MISSING',
  CONNECTION_LOST: 'CONNECTION_LOST',
  JOB_CANCELLED: 'JOB_CANCELLED',
});

/** Từ chung — không bao giờ là mã, dù trang có gắn nhãn "coupon code". */
export const GENERIC_CODE_WORDS = new Set([
  'COUPON', 'COUPONS', 'DISCOUNT', 'DISCOUNTS', 'OFFER', 'OFFERS', 'PROMO', 'PROMOS', 'PROMOCODE',
  'CODE', 'CODES', 'SALE', 'SALES', 'DEAL', 'DEALS', 'VOUCHER', 'VOUCHERS', 'SHOP', 'SHOPNOW',
  'CLICK', 'FREE', 'NEW', 'GET', 'SAVE', 'SAVING', 'SAVINGS', 'TODAY', 'VERIFIED', 'EXCLUSIVE',
  'SITEWIDE', 'STOREWIDE', 'NOCODE', 'NOCODENEEDED', 'NONEEDED', 'ACTIVE', 'EXPIRED', 'TERMS',
  'SHIPPING', 'FREESHIP', 'SEEDETAILS', 'SHOWCODE', 'GETCODE', 'GETDEAL', 'REVEALCODE', 'COPYCODE',
  'NOCODEREQUIRED', 'DEALACTIVATED', 'ONLINE', 'STORE', 'HOME', 'ABOUT', 'LOGIN', 'SIGNUP',
  'ACTIVITY', 'ADDITION', 'ADDITIONS', 'AVAILABLE', 'AVAILABILITY', 'EXPIRATION', 'EXPIRATIONS',
]);

/** Nhãn khẳng định đây là ô mã — bằng chứng mạnh nhất sau nút reveal. */
const CODE_LABELS = [
  /\bcoupon\s*code\b/i, /\bpromo(?:tion(?:al)?)?\s*code\b/i, /\bdiscount\s*code\b/i,
  /\bvoucher\s*code\b/i, /\boffer\s*code\b/i, /\buse\s+code\b/i, /\bapply\s+code\b/i,
  /\bmã\s*giảm\s*giá\b/i, /\bmã\s*khuyến\s*mãi\b/i, /\bcode\s*promo\b/i, /\bgutschein(?:code)?\b/i,
];
const REVEAL_LABELS = [
  /\bshow\s+(?:me\s+)?(?:the\s+)?code\b/i, /\breveal\s+code\b/i, /\bget\s+code\b/i,
  /\bview\s+code\b/i, /\bcopy\s+code\b/i, /\bsee\s+code\b/i, /\bunlock\s+code\b/i,
];
/** Ưu đãi không mã — phải nhận ra để KHÔNG bịa mã cho nó. */
const DEAL_ONLY_LABELS = [
  /\bno\s+code\s+(?:needed|required)\b/i, /\bdeal\s+activated\b/i, /\bget\s+deal\b/i,
  /\bshop\s+(?:now|sale)\b/i, /\bno\s+coupon\s+needed\b/i,
];

const CODE_SHAPE = /^[A-Z0-9][A-Z0-9._-]{2,31}$/;
const OFFER_VALUE = /(\d{1,3})\s*%|\$\s?(\d{1,4})|\b(\d{1,4})\s*(?:usd|eur|gbp|off)\b/i;

const stripWww = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

/** Chuẩn hoá để dedupe. Bỏ mọi khoảng trắng, viết hoa. Giữ `-`/`_`/`.` vì chúng phân biệt mã. */
export function normalizeCode(value) {
  return String(value ?? '').toUpperCase().replace(/\s+/g, '');
}

export function hostOf(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    return parsed.protocol === 'https:' ? stripWww(parsed.hostname) : '';
  } catch { return ''; }
}

/** Domain đăng ký được (bỏ subdomain 1 cấp đơn giản — đủ cho so khớp merchant, không thay PSL đầy đủ). */
export function registrableDomain(value) {
  const host = stripWww(String(value || '').includes('://') ? hostOf(value) : value);
  if (!host || !host.includes('.')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoLevelTld = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevelTld ? -3 : -2).join('.');
}

/**
 * Hình dạng mã hợp lệ. Đây là điều kiện CẦN, không phải điều kiện ĐỦ — vẫn phải có bằng chứng cấu trúc.
 */
export function isPlausibleCode(value) {
  const code = normalizeCode(value);
  if (!code || code.length < 3 || code.length > 32) return false;
  if (GENERIC_CODE_WORDS.has(code)) return false;
  if (!CODE_SHAPE.test(code)) return false;
  if (/^\d+$/.test(code) && code.length < 5) return false;      // "20" là số giảm giá, không phải mã
  return /\d/.test(code) || code.length >= 5;
}

/** Mã trùng tên thương hiệu mà không có bằng chứng khác → không nhận (brief §6). */
export function looksLikeBrandEcho(code, merchant) {
  const norm = normalizeCode(code);
  const brand = normalizeCode(merchant?.name).replace(/[^A-Z0-9]/g, '');
  const domainRoot = normalizeCode(registrableDomain(merchant?.domain).split('.')[0]);
  return Boolean(brand && norm === brand) || Boolean(domainRoot && norm === domainRoot);
}

export function hasCodeLabel(text) { return CODE_LABELS.some((re) => re.test(String(text ?? ''))); }
export function hasRevealLabel(text) { return REVEAL_LABELS.some((re) => re.test(String(text ?? ''))); }
export function isDealOnly(text) {
  const value = String(text ?? '');
  return DEAL_ONLY_LABELS.some((re) => re.test(value)) && !hasCodeLabel(value);
}

/**
 * Trang này có đúng merchant của dự án không.
 * `exact` khi domain khớp; `named` khi chỉ thấy tên thương hiệu; `unknown` khi không có bằng chứng;
 * `mismatch` khi trang khai một merchant khác. `mismatch` phải bị loại (WRONG_MERCHANT).
 */
export function matchMerchant(pageMerchant, merchant) {
  const wantDomain = registrableDomain(merchant?.domain);
  const wantNames = [merchant?.name, ...(merchant?.aliases || [])]
    .map((n) => normalizeCode(n).replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const seenDomains = (pageMerchant?.domains || []).map(registrableDomain).filter(Boolean);
  const seenNames = (pageMerchant?.names || [])
    .map((n) => normalizeCode(n).replace(/[^A-Z0-9]/g, '')).filter(Boolean);

  if (wantDomain && seenDomains.includes(wantDomain)) return { state: 'exact', evidence: 'domain' };
  if (wantNames.some((want) => seenNames.some((seen) => seen === want))) {
    return { state: 'named', evidence: 'name' };
  }
  if (seenDomains.length && wantDomain && !seenDomains.includes(wantDomain)) {
    return { state: 'mismatch', evidence: 'other_domain', observed: seenDomains };
  }
  if (seenNames.length && wantNames.length) return { state: 'mismatch', evidence: 'other_name', observed: seenNames };
  return { state: 'unknown', evidence: 'none' };
}

/**
 * Chấm độ tin 0..1 từ BẰNG CHỨNG QUAN SÁT ĐƯỢC. Không có bằng chứng cấu trúc nào → trả 0 để bị loại.
 * Đây không phải "điểm ưu tiên" nghiệp vụ — nó là độ tin của phép trích xuất, luôn kèm evidence.
 */
export function scoreCandidate(block, merchantMatch) {
  const reasons = [];
  let score = 0;
  if (block?.method === 'reveal_button') { score += 0.35; reasons.push('reveal_button'); }
  else if (block?.method === 'structured_data') { score += 0.35; reasons.push('structured_data'); }
  else if (block?.method === 'data_attribute') { score += 0.3; reasons.push('data_attribute'); }
  else if (block?.method === 'labelled_text') { score += 0.25; reasons.push('labelled_text'); }
  else if (block?.method === 'clipboard') { score += 0.3; reasons.push('clipboard'); }
  else if (block?.method === 'serp_snippet') { score += 0.2; reasons.push('serp_snippet'); }

  if (block?.in_coupon_component) { score += 0.15; reasons.push('coupon_component'); }
  if (hasCodeLabel(block?.label) || hasCodeLabel(block?.context_text)) { score += 0.2; reasons.push('code_label'); }
  if (block?.offer_text && OFFER_VALUE.test(block.offer_text)) { score += 0.1; reasons.push('offer_value'); }

  if (merchantMatch?.state === 'exact') { score += 0.2; reasons.push('merchant_domain_match'); }
  else if (merchantMatch?.state === 'named') { score += 0.1; reasons.push('merchant_name_match'); }
  else if (merchantMatch?.state === 'unknown') { score -= 0.1; reasons.push('merchant_unknown'); }

  if (block?.expiry) { score += 0.05; reasons.push('has_expiry'); }
  return { confidence: Math.max(0, Math.min(1, Number(score.toFixed(3)))), reasons };
}

/**
 * Lọc + chấm một trang. Trả về ứng viên hợp lệ và danh sách bị loại kèm LÝ DO (không im lặng bỏ).
 */
export function evaluateBlocks(blocks, { merchant, pageMerchant, existingCodes = [], sourceUrl = '', searchQuery = null, collectedAt = null } = {}) {
  const merchantMatch = matchMerchant(pageMerchant, merchant);
  const known = new Set((existingCodes || []).map(normalizeCode));
  const sourceDomain = hostOf(sourceUrl);
  const accepted = [];
  const dropped = [];
  const drop = (block, reason) => dropped.push({ code: block?.code ?? null, reason, method: block?.method ?? null });

  if (merchantMatch.state === 'mismatch') {
    for (const block of blocks || []) drop(block, 'wrong_merchant');
    return { candidates: [], dropped, merchant_match: merchantMatch, error_code: COUPON_ERROR_CODES.WRONG_MERCHANT };
  }

  for (const block of blocks || []) {
    if (isDealOnly(block?.context_text) && !block?.code) { drop(block, 'deal_without_code'); continue; }
    if (!isPlausibleCode(block?.code)) { drop(block, 'implausible_code'); continue; }
    const norm = normalizeCode(block.code);
    if (known.has(norm)) { drop(block, 'already_known'); continue; }
    if (looksLikeBrandEcho(norm, merchant) && block.method !== 'reveal_button'
        && block.method !== 'structured_data') { drop(block, 'brand_echo_without_evidence'); continue; }
    const { confidence, reasons } = scoreCandidate(block, merchantMatch);
    if (confidence <= 0) { drop(block, 'no_structural_evidence'); continue; }
    accepted.push({
      code: String(block.code).trim(),
      normalized_code: norm,
      offer_text: block.offer_text ?? null,
      expiry: block.expiry ?? null,
      source_domain: sourceDomain,
      source_url: sourceUrl,
      search_query: searchQuery,
      confidence,
      evidence: {
        method: block.method ?? null,
        label: block.label ?? null,
        snippet: (block.context_text ?? '').slice(0, 300) || null,
        reasons,
        merchant_match: merchantMatch.state,
      },
      collected_at: collectedAt,
    });
  }
  return { candidates: dedupeCandidates(accepted).candidates, dropped, merchant_match: merchantMatch };
}

/**
 * Gộp mã trùng nhưng GIỮ mọi nguồn đã tìm thấy (brief §6). Điểm lấy bản cao nhất, cộng thưởng đa nguồn.
 */
export function dedupeCandidates(candidates) {
  const byCode = new Map();
  let merged = 0;
  for (const candidate of candidates || []) {
    const key = normalizeCode(candidate?.normalized_code || candidate?.code);
    if (!key) continue;
    const prior = byCode.get(key);
    if (!prior) {
      byCode.set(key, { ...candidate, normalized_code: key, sources: [sourceOf(candidate)] });
      continue;
    }
    merged += 1;
    if (!prior.sources.some((s) => s.source_url === candidate.source_url)) prior.sources.push(sourceOf(candidate));
    prior.confidence = Math.min(1, Math.max(prior.confidence, candidate.confidence) + 0.05 * (prior.sources.length - 1));
    prior.offer_text = prior.offer_text || candidate.offer_text || null;
    prior.expiry = prior.expiry || candidate.expiry || null;
  }
  return {
    candidates: [...byCode.values()].sort((a, b) => b.confidence - a.confidence
      || a.normalized_code.localeCompare(b.normalized_code)),
    merged,
  };
}

function sourceOf(candidate) {
  return {
    source_domain: candidate?.source_domain ?? null,
    source_url: candidate?.source_url ?? null,
    search_query: candidate?.search_query ?? null,
    method: candidate?.evidence?.method ?? null,
  };
}

/** Đã đủ mã chưa — điều kiện dừng job (brief §7). */
export function reachedTarget(candidates, targetCount) {
  return (candidates?.length ?? 0) >= Math.max(1, Number(targetCount) || 5);
}
