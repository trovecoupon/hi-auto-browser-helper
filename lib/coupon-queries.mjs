/**
 * Sinh truy vấn Google cho Coupon Discovery + ngân sách theo độ sâu.
 * Thuần, không mạng, không DOM. Truy vấn LUÔN có trần — không có vòng lặp vô hạn.
 */

import { registrableDomain } from './coupon-codes.mjs';

/** Từ điển theo ngôn ngữ. Thêm ngôn ngữ = thêm một khoá, không phải sửa code. */
export const COUPON_TERMS = Object.freeze({
  en: ['coupon code', 'promo code', 'discount code', 'voucher code'],
  vi: ['mã giảm giá', 'mã khuyến mãi', 'coupon code'],
  de: ['gutscheincode', 'rabattcode', 'promo code'],
  fr: ['code promo', 'code de réduction', 'coupon'],
  es: ['código promocional', 'código de descuento', 'cupón'],
  pt: ['código promocional', 'cupom de desconto'],
  it: ['codice sconto', 'codice promozionale'],
  nl: ['kortingscode', 'promocode'],
});

/**
 * Nguồn coupon đối thủ mặc định. Chỉ mở trang trong danh sách này hoặc trong `preferred_sources`
 * của job — KHÔNG mở URL tuỳ ý từ SERP.
 */
export const DEFAULT_COUPON_SOURCES = Object.freeze([
  'retailmenot.com', 'coupons.com', 'slickdeals.net', 'dealspotr.com', 'couponfollow.com',
  'wethrift.com', 'knoji.com', 'simplycodes.com', 'offers.com', 'promocodes.com',
  'couponcabin.com', 'dontpayfull.com', 'coupert.com', 'hotdeals.com', 'couponbirds.com',
  'valuecom.com', 'tenereteam.com', 'couponchief.com', 'sociablelabs.com', 'vouchercodes.co.uk',
]);

/** Ngân sách theo độ sâu — khớp `SEARCH_DEPTHS` / `DEPTH_SOURCE_BUDGET` ở backend. */
export const DEPTH_BUDGETS = Object.freeze({
  quick: { queries: 2, sources: 5, target: 10, timeBudgetMs: 90_000 },
  normal: { queries: 5, sources: 8, target: 10, timeBudgetMs: 240_000 },
  deep: { queries: 12, sources: 20, target: 10, timeBudgetMs: 600_000 },
});

export function budgetFor(searchDepth) {
  return DEPTH_BUDGETS[searchDepth] ?? DEPTH_BUDGETS.normal;
}

function termsFor(language) {
  const key = String(language || 'en').toLowerCase().slice(0, 2);
  const terms = COUPON_TERMS[key] ?? COUPON_TERMS.en;
  // Luôn giữ tiếng Anh làm dự phòng: nhiều site coupon quốc tế vẫn dùng nhãn tiếng Anh.
  return key === 'en' ? terms : [...terms, ...COUPON_TERMS.en.slice(0, 2)];
}

const quoted = (value) => `"${String(value ?? '').replace(/"/g, '').trim()}"`;

/**
 * Danh sách truy vấn theo thứ tự ưu tiên, đã cắt theo ngân sách.
 * Bậc 1: brand + biến thể coupon. Bậc 2: site:đối thủ. Bậc 3: alias.
 */
export function buildQueries({ merchant, market = {}, searchDepth = 'normal', preferredSources = [] } = {}) {
  const budget = budgetFor(searchDepth);
  const name = String(merchant?.name ?? '').trim();
  const domain = registrableDomain(merchant?.domain);
  if (!name && !domain) return { queries: [], budget, reason: 'missing_merchant' };
  const subject = name || domain;
  const terms = termsFor(market.language);
  const sources = [...new Set([...(preferredSources || []), ...DEFAULT_COUPON_SOURCES])]
    .map(registrableDomain).filter(Boolean);

  const tier1 = terms.map((term) => `${quoted(subject)} ${term}`);
  const tier2 = sources.slice(0, Math.max(2, Math.ceil(budget.queries / 2)))
    .map((site) => `site:${site} ${quoted(subject)}`);
  const tier3 = (merchant?.aliases || []).filter(Boolean).slice(0, 2)
    .map((alias) => `${quoted(alias)} ${terms[0]}`);
  const domainQuery = domain && domain !== subject.toLowerCase() ? [`${quoted(domain)} ${terms[0]}`] : [];

  const ordered = [];
  const seen = new Set();
  for (const query of [...tier1.slice(0, 2), ...tier2.slice(0, 2), ...tier1.slice(2), ...domainQuery, ...tier3, ...tier2.slice(2)]) {
    const trimmed = query.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
    if (ordered.length >= budget.queries) break;
  }
  return { queries: ordered, budget, sources };
}

/** URL Google cho một truy vấn. Chỉ `google.com/search` — không bao giờ host khác. */
export function buildSearchUrl(query, market = {}) {
  const params = new URLSearchParams({ q: String(query ?? '') });
  if (market.country) params.set('gl', String(market.country).toLowerCase().slice(0, 2));
  if (market.language) params.set('hl', String(market.language).toLowerCase().slice(0, 5));
  params.set('num', '10');
  return `https://www.google.com/search?${params.toString()}`;
}

/**
 * Kết quả SERP nào đáng mở, giữ nguyên thứ tự Google. Nhận nguồn coupon đã biết, domain merchant hoặc
 * kết quả HTTPS có title/snippet nói rõ coupon/promo; nhờ vậy kết quả #1–#2 phù hợp không bị bỏ chỉ vì
 * chưa nằm trong allowlist cũ. Mọi origin mới vẫn phải được người dùng cấp quyền trước khi đọc.
 */
export function selectSourcesToOpen(results, { merchant, allowedSources = DEFAULT_COUPON_SOURCES, limit = 8, visited = [] } = {}) {
  const allow = new Set(allowedSources.map(registrableDomain).filter(Boolean));
  const merchantDomain = registrableDomain(merchant?.domain);
  if (merchantDomain) allow.add(merchantDomain);
  const seen = new Set(visited.map(registrableDomain).filter(Boolean));
  const picked = [];
  const skipped = [];
  for (const [index, result] of (results || []).entries()) {
    const host = registrableDomain(result?.url);
    if (!host) { skipped.push({ url: result?.url ?? null, reason: 'invalid_url' }); continue; }
    let secure = false;
    try { secure = new URL(result.url).protocol === 'https:'; } catch { /* invalid_url đã xử lý ở trên */ }
    const couponRelevant = /\b(?:coupon|promo(?:tional)?|discount|voucher|gutschein|rabatt|korting|code promo|mã giảm giá)\b/i
      .test(`${result.title ?? ''} ${result.snippet ?? ''}`);
    if (!allow.has(host) && !(secure && couponRelevant)) {
      skipped.push({ url: result.url, reason: 'not_coupon_relevant' }); continue;
    }
    if (seen.has(host)) { skipped.push({ url: result.url, reason: 'domain_already_visited' }); continue; }
    seen.add(host);
    picked.push({ ...result, serp_rank: Number(result.serp_rank) || index + 1,
      source_domain: host, is_merchant_site: host === merchantDomain });
    if (picked.length >= limit) break;
  }
  return { open: picked, skipped };
}

/** Lý do dừng job (brief §7) — luôn phải nói rõ vì sao dừng, không dừng im lặng. */
export function stopReason({ candidates = [], targetCount = 5, queriesRun = 0, sourcesOpened = 0,
  budget = DEPTH_BUDGETS.normal, elapsedMs = 0, cancelled = false, blocked = null } = {}) {
  if (cancelled) return { stop: true, reason: 'user_stopped', result_status: 'completed' };
  if (blocked === 'captcha') return { stop: true, reason: 'captcha', result_status: 'needs_captcha' };
  if (blocked === 'google_blocked') return { stop: true, reason: 'google_blocked', result_status: 'google_blocked' };
  if (blocked === 'source_blocked') return { stop: true, reason: 'source_blocked', result_status: 'source_blocked' };
  if (candidates.length >= targetCount) return { stop: true, reason: 'target_reached', result_status: 'candidates_found' };
  if (elapsedMs >= budget.timeBudgetMs) {
    return { stop: true, reason: 'time_budget', result_status: candidates.length ? 'candidates_found' : 'no_results' };
  }
  if (queriesRun >= budget.queries) {
    return { stop: true, reason: 'query_budget', result_status: candidates.length ? 'candidates_found' : 'no_results' };
  }
  if (sourcesOpened >= budget.sources) {
    return { stop: true, reason: 'source_budget', result_status: candidates.length ? 'candidates_found' : 'no_results' };
  }
  return { stop: false, reason: null, result_status: null };
}
