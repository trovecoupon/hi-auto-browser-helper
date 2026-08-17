/**
 * Trích xuất coupon từ HTML/snapshot + đọc trang kết quả Google. Thuần, không mạng, không jsdom.
 *
 * Content script chạy trên DOM thật dựng snapshot cùng hình dạng; các hàm ở đây xử lý snapshot đó.
 * Đường HTML tồn tại để test offline bằng fixture và làm dự phòng khi DOM bị che.
 */

import { hasCodeLabel, hasRevealLabel, isDealOnly, isPlausibleCode, normalizeCode, registrableDomain } from './coupon-codes.mjs';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const COUPON_COMPONENT_HINT = /(coupon|promo|voucher|offer|discount|deal)/i;

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

export function textOf(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseAttrs(raw) {
  const attrs = {};
  for (const match of String(raw ?? '').matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  for (const match of String(raw ?? '').matchAll(/(?:^|\s)([a-zA-Z_:][\w:.-]*)(?=\s|$)/g)) {
    const name = match[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = '';
  }
  return attrs;
}

/**
 * Quét mọi phần tử của HTML, trả `{tag, attrs, inner, outer, depth}`.
 * Đếm thẻ mở/đóng cùng tên để lấy đúng inner của phần tử lồng nhau — không cắt theo cửa sổ ký tự.
 */
export function scanElements(html, { limit = 4000 } = {}) {
  const source = String(html ?? '');
  const out = [];
  const openTag = /<([a-zA-Z][\w-]*)\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = openTag.exec(source)) && out.length < limit) {
    const [full, rawTag, rawAttrs, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (VOID_TAGS.has(tag) || selfClosing === '/') {
      out.push({ tag, attrs: parseAttrs(rawAttrs), inner: '', outer: full, start: match.index });
      continue;
    }
    const innerStart = match.index + full.length;
    const nested = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
    nested.lastIndex = innerStart;
    let depth = 1;
    let innerEnd = -1;
    let step;
    while ((step = nested.exec(source))) {
      if (step[2] === '/') continue;
      depth += step[1] === '/' ? -1 : 1;
      if (depth === 0) { innerEnd = step.index; break; }
    }
    if (innerEnd < 0) innerEnd = source.length;
    out.push({
      tag, attrs: parseAttrs(rawAttrs), start: match.index,
      inner: source.slice(innerStart, innerEnd),
      outer: source.slice(match.index, innerEnd),
    });
  }
  return out;
}

/** Phát hiện CAPTCHA / chặn. KHÔNG bao giờ tự vượt — chỉ báo để job chuyển sang needs_user. */
export function detectChallenge({ url = '', title = '', text = '', html = '' } = {}) {
  const haystack = `${title} ${text} ${textOf(html)}`.toLowerCase();
  const target = String(url || '').toLowerCase();
  if (/\/sorry\/|\/recaptcha\//.test(target)) return 'captcha';
  if (/unusual traffic|not a robot|verify (?:that )?you are human|xác minh bạn không phải/.test(haystack)) return 'captcha';
  if (/\bcaptcha\b|hcaptcha|cf-turnstile|cf-chl-|challenge-platform/.test(haystack)) return 'captcha';
  // Cloudflare thường dựng challenge bằng JS sau sự kiện load; các câu này xuất hiện trước widget.
  // Coi là CAPTCHA để khóa tab chờ người dùng, không coi trang rỗng rồi tự chuyển nguồn.
  if (/just a moment|checking (?:your )?browser|performing security verification|attention required[^<]{0,40}cloudflare|enable javascript and cookies to continue|cloudflare ray id/.test(haystack)) return 'captcha';
  if (/our systems have detected|automated queries/.test(haystack)) return 'google_blocked';
  if (/access denied|request blocked|rate limit|too many requests|error 1015/.test(haystack)) return 'source_blocked';
  return null;
}

/** Cần đăng nhập không (chuyển job sang needs_login, không tự điền form). */
export function detectLoginWall({ title = '', text = '', html = '' } = {}) {
  const haystack = `${title} ${text} ${textOf(html)}`.toLowerCase();
  return /\bsign in to (?:view|see|reveal)\b|\blog in to (?:view|see|reveal)\b|members only/.test(haystack);
}

// ── Google SERP ─────────────────────────────────────────────────────────────
/**
 * Đọc kết quả tự nhiên của Google từ HTML. Ưu tiên semantic (thẻ h3 + anchor có href thật),
 * không phụ thuộc một class CSS duy nhất — Google đổi class liên tục.
 */
export function parseGoogleResults(html, { limit = 12 } = {}) {
  const source = String(html ?? '');
  const challenge = detectChallenge({ html: source });
  if (challenge) return { results: [], challenge, recognized: false };
  const results = [];
  const seen = new Set();
  for (const anchor of scanElements(source).filter((el) => el.tag === 'a' && el.attrs.href)) {
    const url = normalizeGoogleHref(anchor.attrs.href);
    if (!url) continue;
    const domain = registrableDomain(url);
    if (!domain || /(^|\.)google\.[a-z.]+$/.test(domain) || /(^|\.)(youtube|facebook|instagram|twitter|x|tiktok|pinterest|linkedin)\.[a-z.]+$/.test(domain)) continue;
    if (seen.has(url)) continue;
    const heading = anchor.inner.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const title = textOf(heading?.[1] ?? anchor.inner);
    if (!title) continue;
    seen.add(url);
    results.push({ title, url, domain, snippet: snippetNear(source, anchor.start) });
    if (results.length >= limit) break;
  }
  return { results, challenge: null, recognized: /id=["'](?:search|rso)["']/.test(source) || results.length > 0 };
}

function normalizeGoogleHref(href) {
  const raw = decodeEntities(href);
  if (raw.startsWith('/url?')) {
    const target = new URLSearchParams(raw.slice(raw.indexOf('?') + 1)).get('q');
    return target && target.startsWith('https://') ? target : null;
  }
  return raw.startsWith('https://') ? raw : null;
}

function snippetNear(source, index) {
  const window = source.slice(index, index + 2400);
  const match = window.match(/<(?:div|span)\b[^>]*(?:data-sncf|VwiC3b|MUxGbd)[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
  return textOf(match?.[1] ?? window.slice(0, 900)).slice(0, 400);
}

/** Mã lộ ngay trong snippet SERP — nguồn rẻ nhất, nhưng bằng chứng yếu nên điểm thấp. */
export function codesFromSnippet(snippet) {
  const text = String(snippet ?? '');
  const blocks = [];
  // Nhãn cho phép cả hoa lẫn thường, nhưng MÃ bắt buộc viết hoa — bật cờ `i` sẽ nuốt cả chữ thường
  // trong câu và biến mọi từ thành "mã".
  const labelled = /\b(?:[Uu]se|[Aa]pply|[Ww]ith|[Cc]oupon|[Pp]romo|[Dd]iscount|[Vv]oucher)\s*(?:[Cc]ode)?\s*[:：]?\s*["'“]?([A-Z0-9][A-Z0-9._-]{2,31})["'”]?/g;
  for (const match of text.matchAll(labelled)) {
    blocks.push({
      code: match[1], method: 'serp_snippet', label: null, context_text: text,
      in_coupon_component: false, offer_text: text.slice(0, 200), expiry: null,
    });
  }
  return blocks;
}

// ── Trang nguồn coupon ──────────────────────────────────────────────────────
/**
 * Dựng snapshot từ HTML một trang coupon: merchant quan sát được + các block ứng viên kèm phương pháp.
 * Mỗi block PHẢI khai `method` — không có phương pháp thì không phải bằng chứng.
 */
export function couponSnapshotFromHtml(html, sourceUrl) {
  const source = String(html ?? '');
  const elements = scanElements(source);
  const pageText = textOf(source);
  const blocks = [];
  const push = (block) => { if (block?.code) blocks.push(block); };

  // 1. Structured data (JSON-LD) — bằng chứng mạnh nhất, do chính site khai báo.
  const jsonld = [];
  for (const script of elements.filter((el) => el.tag === 'script' && /ld\+json/i.test(el.attrs.type ?? ''))) {
    try { jsonld.push(JSON.parse(decodeEntities(script.inner))); } catch { /* JSON-LD hỏng thì bỏ, không đoán. */ }
  }
  for (const node of flatten(jsonld)) {
    const code = node?.couponCode ?? node?.discountCode ?? node?.priceSpecification?.couponCode;
    if (!code) continue;
    push({
      code: String(code), method: 'structured_data', label: node['@type'] ?? 'Offer',
      context_text: String(node.description ?? node.name ?? ''), in_coupon_component: true,
      offer_text: String(node.description ?? node.name ?? '') || null,
      expiry: node.validThrough ?? node.availabilityEnds ?? null,
    });
  }

  // 2. Thuộc tính data-* mang mã (kể cả clipboard).
  for (const el of elements) {
    for (const [name, value] of Object.entries(el.attrs)) {
      if (!/^data-[\w-]*(code|coupon|clipboard|voucher)[\w-]*$/.test(name)) continue;
      if (!value || value.length > 40) continue;
      const clipboard = /clipboard/.test(name);
      push({
        code: value, method: clipboard ? 'clipboard' : 'data_attribute', label: name,
        context_text: textOf(el.outer).slice(0, 400),
        in_coupon_component: isCouponComponent(el),
        offer_text: nearestOfferText(elements, el), expiry: nearestExpiry(el),
      });
    }
  }

  // 3. Nút reveal — mã có thể nằm ngay trong card chứa nút.
  for (const el of elements) {
    const label = textOf(el.inner);
    if (!label || label.length > 60 || !hasRevealLabel(label)) continue;
    const card = enclosingCard(elements, el) ?? el;
    const cardText = textOf(card.outer);
    // Mã bị che (`SAVE••••`) chỉ lộ sau khi người dùng bấm. Không đoán phần bị che —
    // content script sẽ bấm nút rồi đọc lại DOM/clipboard, còn đường HTML này bỏ qua.
    const code = codeNearLabel(cardText);
    push({
      code, method: 'reveal_button', label,
      context_text: cardText.slice(0, 400), in_coupon_component: true,
      offer_text: offerTextFrom(cardText), expiry: nearestExpiry(card),
    });
  }

  // 4. Văn bản có nhãn rõ ràng ("Use code: XXXX").
  for (const el of elements) {
    if (!isCouponComponent(el)) continue;
    const cardText = textOf(el.outer);
    if (!hasCodeLabel(cardText) || isDealOnly(cardText)) continue;
    const code = codeNearLabel(cardText);
    push({
      code, method: 'labelled_text', label: labelIn(cardText),
      context_text: cardText.slice(0, 400), in_coupon_component: true,
      offer_text: offerTextFrom(cardText), expiry: nearestExpiry(el),
    });
  }

  // 5. Nhiều site merchant không dùng card/class coupon mà viết thẳng mã trong heading hoặc đoạn văn,
  // ví dụ: <h2>Use the Promo Code "FREEDOMAIN"</h2>. Nhãn + hình dạng mã vẫn là bằng chứng
  // cấu trúc; chỉ quét phần tử văn bản ngắn để không biến mọi chữ viết hoa trên cả trang thành coupon.
  const semanticTextTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th']);
  for (const el of elements) {
    if (!semanticTextTags.has(el.tag)) continue;
    const labelledText = textOf(el.outer);
    if (labelledText.length < 8 || labelledText.length > 600 || !hasCodeLabel(labelledText) || isDealOnly(labelledText)) continue;
    for (const code of codesNearLabels(labelledText)) {
      push({
        code, method: 'labelled_text', label: labelIn(labelledText),
        context_text: labelledText.slice(0, 400), in_coupon_component: isCouponComponent(el),
        offer_text: offerTextFrom(labelledText), expiry: nearestExpiry(el),
      });
    }
  }

  // Một số trang che mã trên nút nhưng ghi nguyên mã trong lịch sử xác nhận, chẳng hạn
  // `tested the code "STORYSAVER"`. Đây là bằng chứng trực tiếp, không phải đoán phần mã bị che.
  const confirmedCode = /\b(?:tested|applied|used|entered|verified|confirmed)\s+(?:successfully\s+)?(?:the\s+)?(?:(?:coupon|promo|discount|voucher)\s+)?code\s*["'“”]([A-Za-z0-9][A-Za-z0-9._-]{2,31})["'“”]/gi;
  for (const el of elements) {
    if (!semanticTextTags.has(el.tag)) continue;
    const statement = textOf(el.outer);
    if (statement.length > 800) continue;
    for (const match of statement.matchAll(confirmedCode)) {
      push({
        code: match[1], method: 'labelled_text', label: 'confirmed code',
        context_text: statement.slice(0, 400), in_coupon_component: isCouponComponent(el),
        offer_text: offerTextFrom(statement), expiry: nearestExpiry(el),
      });
    }
  }

  return {
    source_url: sourceUrl ?? null,
    merchant: observedMerchant(source, elements, pageText, sourceUrl),
    blocks: dedupeBlocks(blocks),
    deal_only: isDealOnly(pageText) && blocks.length === 0,
    challenge: detectChallenge({ url: sourceUrl, html: source }),
    login_wall: detectLoginWall({ html: source }),
  };
}

function flatten(value, out = []) {
  if (Array.isArray(value)) { for (const item of value) flatten(item, out); return out; }
  if (value && typeof value === 'object') {
    out.push(value);
    for (const item of Object.values(value)) if (item && typeof item === 'object') flatten(item, out);
  }
  return out;
}

function isCouponComponent(el) {
  const signal = `${el.attrs.class ?? ''} ${el.attrs.id ?? ''} ${Object.keys(el.attrs).join(' ')}`;
  return COUPON_COMPONENT_HINT.test(signal);
}

function enclosingCard(elements, target) {
  return elements
    .filter((el) => el.start <= target.start && el.start + el.outer.length >= target.start + target.outer.length
      && el !== target && isCouponComponent(el))
    .sort((a, b) => b.start - a.start)[0] ?? null;
}

function codeNearLabel(text) {
  return codesNearLabels(text)[0] ?? null;
}

function codesNearLabels(text) {
  const value = String(text ?? '');
  const pattern = /(?:(?:use|apply|enter)\s+(?:the\s+)?(?:(?:coupon|promo(?:tion(?:al)?)?|discount|voucher|offer)\s+)?code|(?:coupon|promo(?:tion(?:al)?)?|discount|voucher|offer)\s*code)\s*[:：-]?\s*["'“]?([A-Za-z0-9][A-Za-z0-9._-]{2,31})\b/gi;
  const found = [];
  for (const match of value.matchAll(pattern)) {
    const raw = match[1];
    // Mã chữ thuần phải được site viết hoa; mã mixed-case chỉ nhận khi có chữ số. Tránh bắt nhầm
    // các câu kiểu “promo code available today”. Bộ lọc lõi tiếp tục loại từ chung và số ngắn.
    if ((raw === raw.toUpperCase() || /\d/.test(raw)) && isPlausibleCode(raw)) found.push(raw);
  }
  return [...new Set(found.map((code) => normalizeCode(code)))];
}

function labelIn(text) {
  return String(text ?? '').match(/((?:coupon|promo|discount|voucher|offer)\s*code)/i)?.[1] ?? null;
}

function offerTextFrom(text) {
  const value = String(text ?? '');
  const quantified = value.match(/([^.|]*?(?:\d{1,3}\s*%|[$€£]\s?\d{1,4})[^.|]{0,80})/);
  if (quantified?.[1]) return quantified[1].trim().slice(0, 200);
  const qualitative = value.match(/([^.|]{0,90}\b(?:free|bonus|cashback|save|off)\b[^.|]{0,90})/i);
  if (qualitative?.[1]) return qualitative[1].trim().slice(0, 200);
  const labelledOffer = value.match(/([^.|]{0,40}(?:coupon|promo|discount|voucher)\s+code[^.|]{8,140})/i);
  return labelledOffer?.[1]?.trim().slice(0, 200) ?? null;
}

function nearestOfferText(elements, el) {
  const card = enclosingCard(elements, el) ?? el;
  const cardText = textOf(card.outer);
  // Một vùng chứa nhiều mã (bảng lịch sử/toàn trang) không thể cung cấp title riêng cho từng mã.
  // Không gán title đầu tiên của vùng đó cho mọi data-clipboard-code bên dưới.
  const descendants = elements.filter((candidate) => candidate.start >= card.start
    && candidate.start + candidate.outer.length <= card.start + card.outer.length);
  const attributeCodes = descendants.flatMap((candidate) => Object.entries(candidate.attrs)
    .filter(([name]) => /^data-[\w-]*(code|coupon|clipboard|voucher)[\w-]*$/.test(name))
    .map(([, value]) => value));
  const codeLike = new Set([...(cardText.match(/\b[A-Z][A-Z0-9._-]{3,31}\b/g) ?? []), ...attributeCodes]
    .filter((value) => isPlausibleCode(value)).map(normalizeCode));
  if (codeLike.size > 1) return null;
  return offerTextFrom(cardText);
}

function nearestExpiry(el) {
  const text = textOf(el.outer ?? '');
  const match = text.match(/(?:expires?|valid (?:until|through|till)|hết hạn)\s*[:：]?\s*([A-Za-z0-9,\/\- ]{4,24})/i);
  return match?.[1]?.trim() ?? null;
}

function dedupeBlocks(blocks) {
  const rank = { structured_data: 5, reveal_button: 4, clipboard: 3, data_attribute: 2, labelled_text: 1, serp_snippet: 0 };
  const best = new Map();
  for (const block of blocks) {
    const key = normalizeCode(block.code);
    if (!key) continue;
    const prior = best.get(key);
    if (!prior || (rank[block.method] ?? 0) > (rank[prior.method] ?? 0)) best.set(key, block);
  }
  return [...best.values()];
}

/** Merchant mà TRANG tự khai — dùng để phát hiện mở nhầm merchant khác. */
function observedMerchant(html, elements, pageText, sourceUrl) {
  const names = new Set();
  const domains = new Set();
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) names.add(textOf(title).split(/[|\-–—:]/)[0].trim());
  for (const el of elements) {
    if (el.tag === 'h1') names.add(textOf(el.inner));
    const property = (el.attrs.property ?? el.attrs.name ?? '').toLowerCase();
    if (el.tag === 'meta' && /og:site_name|application-name/.test(property) && el.attrs.content) {
      names.add(el.attrs.content);
    }
    if (el.tag === 'a' && el.attrs.href && /\b(visit|go to|store|website|official)\b/i.test(textOf(el.inner))) {
      const host = registrableDomain(el.attrs.href);
      if (host && host !== registrableDomain(sourceUrl)) domains.add(host);
    }
    if (el.attrs['data-merchant-domain']) domains.add(registrableDomain(el.attrs['data-merchant-domain']));
    if (el.attrs['data-merchant'] || el.attrs['data-store']) names.add(el.attrs['data-merchant'] ?? el.attrs['data-store']);
  }
  for (const match of pageText.matchAll(/\b([a-z0-9][a-z0-9-]{1,40}\.(?:com|net|org|io|co|shop|store|eu|vn|de|fr|es|it|nl|co\.uk))\b/gi)) {
    const host = registrableDomain(match[1]);
    if (host && host !== registrableDomain(sourceUrl)) domains.add(host);
  }
  return {
    names: [...names].map((n) => String(n).trim()).filter(Boolean).slice(0, 8),
    domains: [...domains].filter(Boolean).slice(0, 12),
  };
}
