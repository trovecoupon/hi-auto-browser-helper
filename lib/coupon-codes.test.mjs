import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dedupeCandidates, evaluateBlocks, isPlausibleCode, looksLikeBrandEcho, matchMerchant,
  normalizeCode, reachedTarget, registrableDomain, scoreCandidate,
} from './coupon-codes.mjs';
import { buildQueries, buildSearchUrl, selectSourcesToOpen, stopReason } from './coupon-queries.mjs';
import { codesFromSnippet, couponSnapshotFromHtml, detectChallenge, parseGoogleResults } from './coupon-parsers.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'coupon');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const MERCHANT = { name: 'Fitcamx', domain: 'fitcamx.com', aliases: ['Fit Camx'] };

// ── Chuẩn hoá + chặn false-positive ─────────────────────────────────────────
test('normalizeCode bỏ khoảng trắng và viết hoa, giữ dấu phân biệt mã', () => {
  assert.equal(normalizeCode(' save 15 '), 'SAVE15');
  assert.equal(normalizeCode('new-user_10'), 'NEW-USER_10');
});

test('isPlausibleCode loại từ chung, số ngắn và chuỗi quá ngắn', () => {
  for (const bad of ['COUPON', 'PROMO', 'SALE', 'FREE', '20', 'AB', 'GET CODE', 'SHOW CODE']) {
    assert.equal(isPlausibleCode(bad), false, `phải loại: ${bad}`);
  }
  for (const good of ['SAVE15', 'FIRST20', 'WELCOME', 'DASH25', 'NEW-USER10']) {
    assert.equal(isPlausibleCode(good), true, `phải nhận: ${good}`);
  }
});

test('isPlausibleCode loại từ giao diện bị bắt nhầm sau nhãn discount code', () => {
  assert.equal(isPlausibleCode('ACTIVITY'), false);
  assert.equal(isPlausibleCode('ADDITIONS'), false);
});

test('mã trùng tên thương hiệu bị coi là brand echo', () => {
  assert.equal(looksLikeBrandEcho('FITCAMX', MERCHANT), true);
  assert.equal(looksLikeBrandEcho('SAVE15', MERCHANT), false);
});

test('registrableDomain xử lý subdomain và TLD hai cấp', () => {
  assert.equal(registrableDomain('https://www.retailmenot.com/view/x'), 'retailmenot.com');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
});

// ── Đối chiếu merchant ──────────────────────────────────────────────────────
test('matchMerchant phân biệt exact / named / mismatch / unknown', () => {
  assert.equal(matchMerchant({ domains: ['fitcamx.com'], names: [] }, MERCHANT).state, 'exact');
  assert.equal(matchMerchant({ domains: [], names: ['Fitcamx'] }, MERCHANT).state, 'named');
  assert.equal(matchMerchant({ domains: ['vantrue.net'], names: [] }, MERCHANT).state, 'mismatch');
  assert.equal(matchMerchant({ domains: [], names: [] }, MERCHANT).state, 'unknown');
});

// ── Chấm điểm ───────────────────────────────────────────────────────────────
test('nút reveal + khớp domain cho điểm cao hơn snippet SERP không rõ merchant', () => {
  const strong = scoreCandidate(
    { method: 'reveal_button', in_coupon_component: true, label: 'Show coupon code', offer_text: '20% off' },
    { state: 'exact' });
  const weak = scoreCandidate({ method: 'serp_snippet' }, { state: 'unknown' });
  assert.ok(strong.confidence > weak.confidence);
  assert.ok(strong.confidence >= 0.8, `mong đợi ≥0.8, có ${strong.confidence}`);
  assert.ok(strong.reasons.includes('merchant_domain_match'));
});

test('block không có phương pháp nào thì điểm 0 → bị loại', () => {
  assert.equal(scoreCandidate({}, { state: 'unknown' }).confidence, 0);
});

// ── Gộp trùng ───────────────────────────────────────────────────────────────
test('dedupeCandidates gộp mã trùng nhưng giữ đủ mọi nguồn', () => {
  const { candidates, merged } = dedupeCandidates([
    { code: 'SAVE15', normalized_code: 'SAVE15', confidence: 0.6, source_url: 'https://a.com/x', source_domain: 'a.com' },
    { code: 'save15', normalized_code: 'SAVE15', confidence: 0.7, source_url: 'https://b.com/y', source_domain: 'b.com' },
    { code: 'DASH25', normalized_code: 'DASH25', confidence: 0.5, source_url: 'https://a.com/z', source_domain: 'a.com' },
  ]);
  assert.equal(merged, 1);
  assert.equal(candidates.length, 2);
  const save = candidates.find((c) => c.normalized_code === 'SAVE15');
  assert.equal(save.sources.length, 2, 'phải giữ cả hai nguồn');
  assert.ok(save.confidence > 0.7, 'nhiều nguồn thì tin hơn');
});

test('reachedTarget là điều kiện dừng đủ mã', () => {
  assert.equal(reachedTarget([1, 2, 3], 3), true);
  assert.equal(reachedTarget([1], 5), false);
});

// ── Sinh truy vấn ───────────────────────────────────────────────────────────
test('buildQueries tôn trọng ngân sách và không sinh trùng', () => {
  const quick = buildQueries({ merchant: MERCHANT, market: { country: 'US', language: 'en' }, searchDepth: 'quick' });
  assert.equal(quick.queries.length, 2);
  const normal = buildQueries({ merchant: MERCHANT, market: { language: 'en' }, searchDepth: 'normal' });
  assert.equal(normal.queries.length, 5);
  assert.equal(new Set(normal.queries).size, 5, 'không được trùng truy vấn');
  assert.ok(normal.queries[0].includes('"Fitcamx"'));
  assert.ok(normal.queries.some((q) => q.startsWith('site:')), 'phải có truy vấn theo site đối thủ');
});

test('buildQueries đổi từ khoá theo ngôn ngữ', () => {
  const vi = buildQueries({ merchant: MERCHANT, market: { language: 'vi' }, searchDepth: 'normal' });
  assert.ok(vi.queries.some((q) => q.includes('mã giảm giá')));
  const de = buildQueries({ merchant: MERCHANT, market: { language: 'de' }, searchDepth: 'quick' });
  assert.ok(de.queries.some((q) => q.includes('gutscheincode')));
});

test('buildSearchUrl chỉ trỏ google.com/search kèm gl/hl', () => {
  const url = new URL(buildSearchUrl('"Fitcamx" coupon code', { country: 'US', language: 'en' }));
  assert.equal(url.origin + url.pathname, 'https://www.google.com/search');
  assert.equal(url.searchParams.get('gl'), 'us');
  assert.equal(url.searchParams.get('q'), '"Fitcamx" coupon code');
});

test('selectSourcesToOpen mở nguồn tin cậy/phù hợp và mỗi domain một lần', () => {
  const { open, skipped } = selectSourcesToOpen([
    { url: 'https://www.retailmenot.com/view/fitcamx.com' },
    { url: 'https://www.retailmenot.com/view/other' },
    { url: 'https://evil.example/anything' },
    { url: 'https://fitcamx.com/coupons' },
  ], { merchant: MERCHANT, limit: 5 });
  assert.deepEqual(open.map((o) => o.source_domain), ['retailmenot.com', 'fitcamx.com']);
  assert.ok(skipped.some((s) => s.reason === 'not_coupon_relevant'));
  assert.ok(skipped.some((s) => s.reason === 'domain_already_visited'));
  assert.equal(open.find((o) => o.source_domain === 'fitcamx.com').is_merchant_site, true);
});

test('kết quả coupon HTTPS mới vẫn được mở theo đúng thứ tự Google', () => {
  const { open } = selectSourcesToOpen([
    { title: 'Fitcamx Coupon Codes', snippet: 'Save with promo codes', url: 'https://newcoupons.example/fitcamx' },
    { title: 'RetailMeNot Fitcamx', snippet: 'Coupon codes', url: 'https://retailmenot.com/view/fitcamx' },
  ], { merchant: MERCHANT, limit: 5 });
  assert.deepEqual(open.map((item) => [item.source_domain, item.serp_rank]), [
    ['newcoupons.example', 1], ['retailmenot.com', 2],
  ]);
});

// ── Điều kiện dừng ──────────────────────────────────────────────────────────
test('stopReason phủ đủ các nhánh dừng của hợp đồng', () => {
  const budget = { queries: 5, sources: 8, timeBudgetMs: 1000 };
  assert.deepEqual(stopReason({ cancelled: true }), { stop: true, reason: 'user_stopped', result_status: 'completed' });
  assert.equal(stopReason({ blocked: 'captcha' }).result_status, 'needs_captcha');
  assert.equal(stopReason({ blocked: 'google_blocked' }).result_status, 'google_blocked');
  assert.equal(stopReason({ candidates: [1, 2, 3, 4, 5], targetCount: 5 }).reason, 'target_reached');
  assert.equal(stopReason({ queriesRun: 5, budget }).reason, 'query_budget');
  assert.equal(stopReason({ sourcesOpened: 8, budget }).reason, 'source_budget');
  assert.equal(stopReason({ elapsedMs: 2000, budget }).reason, 'time_budget');
  assert.equal(stopReason({ queriesRun: 5, budget }).result_status, 'no_results');
  assert.equal(stopReason({ queriesRun: 1, budget }).stop, false);
});

// ── Fixture: Google SERP ────────────────────────────────────────────────────
test('SERP bình thường: lấy kết quả thật, bỏ Google và mạng xã hội', () => {
  const { results, challenge, recognized } = parseGoogleResults(fixture('google-serp-normal.html'));
  assert.equal(challenge, null);
  assert.equal(recognized, true);
  const domains = results.map((r) => r.domain);
  assert.ok(domains.includes('retailmenot.com'));
  assert.ok(domains.includes('couponfollow.com'));
  assert.ok(!domains.includes('facebook.com'), 'phải bỏ mạng xã hội');
  assert.match(results[0].snippet, /SAVE15/);
});

test('SERP CAPTCHA: nhận diện được, KHÔNG trả kết quả nào', () => {
  const parsed = parseGoogleResults(fixture('google-captcha.html'));
  assert.equal(parsed.challenge, 'captcha');
  assert.equal(parsed.results.length, 0);
  assert.equal(detectChallenge({ url: 'https://www.google.com/sorry/index' }), 'captcha');
});

test('Cloudflare challenge được giữ như CAPTCHA cần người dùng, không coi là trang coupon rỗng', () => {
  assert.equal(detectChallenge({ title: 'Just a moment...', text: 'Checking your browser before accessing the site' }), 'captcha');
  assert.equal(detectChallenge({ text: 'Verify you are human. Cloudflare Ray ID: abc123' }), 'captcha');
  assert.equal(detectChallenge({ html: '<div class="cf-turnstile">Performing security verification</div>' }), 'captcha');
});

test('mã lộ trong snippet SERP được nhặt nhưng là bằng chứng yếu', () => {
  const blocks = codesFromSnippet('Save with 3 Fitcamx coupon codes. Use code SAVE15 for 15% off.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code, 'SAVE15');
  assert.equal(blocks[0].method, 'serp_snippet');
});

// ── Fixture: trang nguồn coupon ─────────────────────────────────────────────
test('trang hiện code: lấy đủ mã kèm offer text và hạn dùng', () => {
  const snap = couponSnapshotFromHtml(fixture('source-visible-code.html'), 'https://examplecoupons.test/fitcamx');
  const codes = snap.blocks.map((b) => b.code);
  assert.ok(codes.includes('SAVE15'), `có ${codes}`);
  assert.ok(codes.includes('SHIP50NOW'));
  const save = snap.blocks.find((b) => b.code === 'SAVE15');
  assert.match(save.expiry ?? '', /Dec 31, 2026/);
  assert.equal(save.in_coupon_component, true);
});

test('trang merchant viết mã trực tiếp trong heading vẫn lấy được, không cần card coupon', () => {
  const snap = couponSnapshotFromHtml(`<!doctype html><html><head><title>ASPHostPortal.com - Promotions</title></head><body>
    <h2>FREE DOMAIN Offer for new registration only. Use Promo Code "FREEDOMAIN"</h2>
    <h2>Use the Promo Code "DBSQL" (without quotes) and receive double SQL Server Space!</h2>
    <p>Promo code available today.</p>
  </body></html>`, 'https://asphostportal.com/Hosting-Promotions');
  assert.deepEqual(snap.blocks.map((block) => block.code).sort(), ['DBSQL', 'FREEDOMAIN']);
});

test('lịch sử xác nhận lấy được mã đầy đủ mà không cần click nút reveal bị che', () => {
  const snap = couponSnapshotFromHtml(`<!doctype html><html><head><title>MilesWeb Promo Codes</title></head><body>
    <h1>MilesWeb Promo Codes</h1><a href="https://www.milesweb.com/">Official website</a>
    <article class="coupon-card"><button>Show promo code</button><span>***SAVER</span>
      <p>On Feb 12, 2026 a shopper tested the code "STORYSAVER" at checkout on milesweb.com.</p>
    </article></body></html>`, 'https://www.dontpayfull.com/at/milesweb.com');
  assert.ok(snap.blocks.some((block) => block.code === 'STORYSAVER'));
  assert.ok(!snap.blocks.some((block) => block.code.includes('*')));
});

test('trang có nút reveal: mã lấy từ clipboard/data-* thắng, mã bị che không bị đoán', () => {
  const snap = couponSnapshotFromHtml(fixture('source-reveal-button.html'), 'https://wethrift.test/fitcamx');
  const codes = snap.blocks.map((b) => b.code);
  assert.ok(codes.includes('FIRST20'), `có ${codes}`);
  assert.ok(codes.includes('STUDENT10'));
  assert.ok(!codes.some((c) => c.includes('•')), 'không được lấy mã bị che');
  assert.equal(snap.blocks.find((b) => b.code === 'FIRST20').method, 'clipboard');
});

test('JSON-LD: mã từ structured data kèm hạn dùng', () => {
  const snap = couponSnapshotFromHtml(fixture('source-jsonld.html'), 'https://deals.test/fitcamx');
  const dash = snap.blocks.find((b) => b.code === 'DASH25');
  assert.ok(dash, 'phải đọc được couponCode trong JSON-LD');
  assert.equal(dash.method, 'structured_data');
  assert.equal(dash.expiry, '2026-12-31');
});

test('mã trong modal sau khi bấm được nhận qua data-coupon-code', () => {
  const snap = couponSnapshotFromHtml(fixture('source-modal-code.html'), 'https://vouchers.test/fitcamx');
  assert.ok(snap.blocks.some((b) => b.code === 'MODAL30'));
});

test('không gán một title chung cho nhiều data-code trong bảng lịch sử', () => {
  const snap = couponSnapshotFromHtml(`<section class="coupon-list">
    <h3>10% Off Your Order</h3>
    <button data-clipboard-text="BONUS10">Copy</button>
    <button data-clipboard-text="CPOFF">Copy</button>
    <button data-best-code="BLOGFAN10">Best code</button>
  </section>`, 'https://www.dontpayfull.com/at/milesweb.com');
  const byCode = new Map(snap.blocks.map((block) => [block.code, block]));
  assert.equal(byCode.get('BONUS10')?.offer_text, null);
  assert.equal(byCode.get('CPOFF')?.offer_text, null);
  assert.equal(byCode.get('BLOGFAN10')?.offer_text, null);
});

test('trang chỉ có deal, không có mã: KHÔNG bịa ra mã nào', () => {
  const snap = couponSnapshotFromHtml(fixture('source-deal-only.html'), 'https://deals.test/fitcamx');
  const result = evaluateBlocks(snap.blocks, { merchant: MERCHANT, pageMerchant: snap.merchant, sourceUrl: 'https://deals.test/fitcamx' });
  assert.equal(result.candidates.length, 0);
});

test('trang sai merchant: loại toàn bộ và báo WRONG_MERCHANT', () => {
  const snap = couponSnapshotFromHtml(fixture('source-wrong-merchant.html'), 'https://examplecoupons.test/vantrue');
  const result = evaluateBlocks(snap.blocks, { merchant: MERCHANT, pageMerchant: snap.merchant, sourceUrl: 'https://examplecoupons.test/vantrue' });
  assert.equal(result.merchant_match.state, 'mismatch');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.error_code, 'WRONG_MERCHANT');
  assert.ok(result.dropped.every((d) => d.reason === 'wrong_merchant'));
});

test('nhiễu từ chung và brand echo bị loại kèm lý do', () => {
  const snap = couponSnapshotFromHtml(fixture('source-generic-noise.html'), 'https://noise.test/fitcamx');
  const result = evaluateBlocks(snap.blocks, { merchant: MERCHANT, pageMerchant: snap.merchant, sourceUrl: 'https://noise.test/fitcamx' });
  assert.equal(result.candidates.length, 0, `không được nhận gì, đang nhận ${JSON.stringify(result.candidates)}`);
  const reasons = new Set(result.dropped.map((d) => d.reason));
  assert.ok(reasons.has('implausible_code') || reasons.has('brand_echo_without_evidence'));
});

test('mã đã biết của dự án không được nhận lại', () => {
  const snap = couponSnapshotFromHtml(fixture('source-visible-code.html'), 'https://examplecoupons.test/fitcamx');
  const result = evaluateBlocks(snap.blocks, {
    merchant: MERCHANT, pageMerchant: snap.merchant, existingCodes: ['save15'],
    sourceUrl: 'https://examplecoupons.test/fitcamx',
  });
  assert.ok(!result.candidates.some((c) => c.normalized_code === 'SAVE15'));
  assert.ok(result.dropped.some((d) => d.reason === 'already_known'));
});

test('ứng viên hợp lệ mang đủ nguồn, truy vấn và bằng chứng', () => {
  const snap = couponSnapshotFromHtml(fixture('source-visible-code.html'), 'https://examplecoupons.test/fitcamx');
  const result = evaluateBlocks(snap.blocks, {
    merchant: MERCHANT, pageMerchant: snap.merchant,
    sourceUrl: 'https://examplecoupons.test/fitcamx', searchQuery: '"Fitcamx" coupon code',
    collectedAt: '2026-08-11T00:00:00Z',
  });
  const save = result.candidates.find((c) => c.normalized_code === 'SAVE15');
  assert.ok(save);
  assert.equal(save.source_domain, 'examplecoupons.test');
  assert.equal(save.search_query, '"Fitcamx" coupon code');
  assert.ok(save.confidence > 0);
  assert.ok(Array.isArray(save.evidence.reasons) && save.evidence.reasons.length > 0);
  assert.equal(save.collected_at, '2026-08-11T00:00:00Z');
});
