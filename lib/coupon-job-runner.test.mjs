import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdapterError, buildHandshake, createRegistry, ERROR_TO_STATUS, isHumanHeld } from './adapter-registry.mjs';
import { evaluateStop, initialCheckpoint, restoreCheckpoint, runStep } from './coupon-job-runner.mjs';
import { couponSnapshotFromHtml, parseGoogleResults } from './coupon-parsers.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'coupon');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const JOB = Object.freeze({
  job_id: 'cdj_test', job_type: 'coupon_discovery',
  merchant: { name: 'Fitcamx', domain: 'fitcamx.com', aliases: [] },
  market: { country: 'US', language: 'en' },
  existing_codes: [], preferred_sources: [], target_count: 5, search_depth: 'normal',
});

/** Driver giả: trả fixture thật, đếm số lần gọi. */
function makeDriver({ serpByQuery = {}, sources = {}, onCandidates = () => {} } = {}) {
  const calls = { search: [], source: [], reported: [] };
  return {
    calls,
    now: () => '2026-08-11T00:00:00Z',
    async runSearch(url, query) {
      calls.search.push(query);
      const html = serpByQuery[query] ?? serpByQuery['*'] ?? fixture('google-serp-normal.html');
      if (html === 'THROW_CAPTCHA') return { challenge: 'captcha', results: [] };
      const parsed = parseGoogleResults(html);
      return { ...parsed, snippet_blocks: [], page_merchant: { names: [], domains: [] } };
    },
    async readCouponSource(target) {
      calls.source.push(target.source_domain);
      const html = sources[target.source_domain] ?? sources['*'];
      if (!html) throw new AdapterError('ELEMENT_NOT_FOUND', `Không có fixture cho ${target.source_domain}`);
      return couponSnapshotFromHtml(html, target.url);
    },
    async reportCandidates(list) { calls.reported.push(...list); onCandidates(list); },
  };
}

// ── Adapter registry ────────────────────────────────────────────────────────
test('registry từ chối adapter thiếu hook bắt buộc', () => {
  const registry = createRegistry();
  assert.throws(() => registry.register({ name: 'broken' }), /thiếu hook bắt buộc/);
});

test('adapter hỏng không kéo theo adapter khác, và bị cách ly sau 3 lần', async () => {
  const registry = createRegistry();
  registry.register({ name: 'good', detect: () => true, start: async () => 'ok' });
  registry.register({ name: 'bad', detect: () => true, start: async () => { throw new Error('nổ'); } });

  for (let i = 0; i < 3; i += 1) {
    const bad = await registry.invoke('bad', 'start');
    assert.equal(bad.ok, false);
    assert.equal(bad.error.name, 'AdapterError');
  }
  const good = await registry.invoke('good', 'start');
  assert.equal(good.ok, true, 'adapter lành phải vẫn chạy');
  assert.equal(good.value, 'ok');

  const names = registry.available({}).map((a) => a.name);
  assert.deepEqual(names, ['good'], 'adapter hỏng liên tiếp phải bị loại khỏi danh sách khả dụng');
  registry.reset('bad');
  assert.equal(registry.available({}).length, 2, 'reset phải bật lại được');
});

test('hook không cài đặt thì bỏ qua chứ không ném lỗi', async () => {
  const registry = createRegistry();
  registry.register({ name: 'minimal', detect: () => true, start: async () => 1 });
  const result = await registry.invoke('minimal', 'pause');
  assert.deepEqual(result, { ok: true, skipped: true, value: null });
});

test('mã lỗi ánh xạ đúng trạng thái job, CAPTCHA/login không tự retry', () => {
  assert.equal(ERROR_TO_STATUS.CAPTCHA_REQUIRED, 'needs_user');
  assert.equal(ERROR_TO_STATUS.LOGIN_REQUIRED, 'needs_login');
  assert.equal(ERROR_TO_STATUS.CONNECTION_LOST, 'failed');
  assert.equal(isHumanHeld('CAPTCHA_REQUIRED'), true);
  assert.equal(isHumanHeld('PAGE_CHANGED'), false);
  assert.equal(new AdapterError('CAPTCHA_REQUIRED', 'x').retryable, false);
  assert.equal(new AdapterError('PAGE_CHANGED', 'x').retryable, true);
});

test('handshake trả đủ trường theo hợp đồng', () => {
  const shake = buildHandshake({
    extensionVersion: '2.0.0',
    adapters: [{ name: 'google-search', detected: true }, 'coupon-source'],
    connectionState: 'connected',
  });
  assert.deepEqual(Object.keys(shake).sort(),
    ['activeJob', 'adapters', 'connectionState', 'extensionVersion', 'protocolVersion', 'queue']);
  assert.equal(shake.protocolVersion, '2.0.0');
  assert.equal(shake.adapters[0].detected, true);
  assert.equal(shake.activeJob, null);
});

// ── Checkpoint ──────────────────────────────────────────────────────────────
test('checkpoint ban đầu sinh đúng số truy vấn theo độ sâu', () => {
  assert.equal(initialCheckpoint(JOB).queries.length, 5);
  assert.equal(initialCheckpoint({ ...JOB, search_depth: 'quick' }).queries.length, 2);
});

test('khôi phục checkpoint giữ nguyên tiến độ đã lưu', () => {
  const saved = { ...initialCheckpoint(JOB), query_index: 3, sources_opened: 2, candidates: [{ normalized_code: 'X1' }] };
  const restored = restoreCheckpoint(JOB, saved);
  assert.equal(restored.query_index, 3);
  assert.equal(restored.sources_opened, 2);
  assert.equal(restored.candidates.length, 1);
});

test('checkpoint hỏng/rỗng thì quay về mặc định an toàn', () => {
  assert.equal(restoreCheckpoint(JOB, null).query_index, 0);
  assert.equal(restoreCheckpoint(JOB, { queries: [] }).queries.length, 5);
  assert.equal(restoreCheckpoint(JOB, 'rác').query_index, 0);
});

test('checkpoint tuần tự hoá được (sống sót khi service worker chết)', () => {
  const round = JSON.parse(JSON.stringify(initialCheckpoint(JOB)));
  assert.deepEqual(round, initialCheckpoint(JOB));
});

// ── Điều kiện dừng ──────────────────────────────────────────────────────────
test('evaluateStop phủ đủ nhánh dừng', () => {
  const cp = initialCheckpoint(JOB);
  assert.equal(evaluateStop(JOB, cp, {}), null);
  assert.equal(evaluateStop(JOB, cp, { cancelled: true }).reason, 'user_stopped');
  assert.equal(evaluateStop(JOB, cp, { blocked: 'captcha' }).result_status, 'needs_captcha');
  assert.equal(evaluateStop(JOB, cp, { blocked: 'captcha' }).error_code, 'CAPTCHA_REQUIRED');
  const titled = { code: 'SAVE20', normalized_code: 'SAVE20', offer_text: 'Save 20% on hosting' };
  assert.equal(evaluateStop(JOB, { ...cp, candidates: Array(10).fill(titled) }, {}).reason, 'coupon_cap_reached');
  assert.equal(evaluateStop(JOB, { ...cp, queries_run: 1, candidates: [titled] }, {}).reason, 'serp_batch_found');
  assert.equal(evaluateStop(JOB, {
    ...cp, queries_run: 1, candidates: [titled], pending_sources: [{ url: 'https://coupon.test/acme' }],
  }, {}), null, 'có mã vẫn phải vét hết nhóm nguồn của SERP hiện tại');
  assert.equal(evaluateStop(JOB, {
    ...cp, queries_run: 1, candidates: [{ code: 'RAW80', normalized_code: 'RAW80', offer_text: null }],
  }, {}), null, 'mã không title chỉ là fallback, phải tiếp tục query để tìm mã có title');
  assert.equal(evaluateStop(JOB, { ...cp, started_at_ms: 0 }, { nowMs: 10 ** 9 }).reason, 'time_budget');
  const drained = { ...cp, query_index: cp.queries.length };
  assert.equal(evaluateStop(JOB, drained, {}).reason, 'query_budget');
  assert.equal(evaluateStop(JOB, drained, {}).result_status, 'no_results');
});

// ── Chạy job đầy đủ ─────────────────────────────────────────────────────────
test('chạy hết một job: tìm Google → mở nguồn → thu mã có nguồn và điểm', async () => {
  const driver = makeDriver({
    sources: {
      'retailmenot.com': fixture('source-visible-code.html'),
      'couponfollow.com': fixture('source-reveal-button.html'),
    },
  });
  let checkpoint = initialCheckpoint(JOB);
  let last;
  for (let i = 0; i < 30; i += 1) {
    last = await runStep(JOB, checkpoint, driver, { nowMs: 1000 + i });
    checkpoint = last.checkpoint;
    if (last.done) break;
  }
  assert.equal(last.done, true);
  assert.equal(last.result_status, 'candidates_found');
  assert.ok(checkpoint.candidates.length >= 1, `phải có ứng viên, đang có ${checkpoint.candidates.length}`);
  for (const candidate of checkpoint.candidates) {
    assert.ok(candidate.source_url.startsWith('https://'), 'mỗi mã phải có URL nguồn');
    assert.ok(candidate.confidence > 0, 'mỗi mã phải có điểm tin cậy');
    assert.ok(candidate.search_query, 'mỗi mã phải biết nó đến từ truy vấn nào');
  }
  assert.ok(driver.calls.reported.length >= 1, 'phải gửi kết quả tạm thời về Hi Auto');
});

test('một SERP quét hết tối đa 5 nguồn rồi dừng nếu đã có ít nhất 1 coupon', async () => {
  const checkpoint = {
    ...initialCheckpoint(JOB), queries_run: 1, query_index: 1,
    batch_source_total: 2, batch_source_done: 0,
    pending_sources: [
      { url: 'https://retailmenot.com/a', source_domain: 'retailmenot.com', search_query: 'q1' },
      { url: 'https://couponfollow.com/a', source_domain: 'couponfollow.com', search_query: 'q1' },
    ],
  };
  const driver = makeDriver({ sources: {
    'retailmenot.com': fixture('source-visible-code.html'),
    'couponfollow.com': fixture('source-reveal-button.html'),
  } });
  const first = await runStep(JOB, checkpoint, driver, { nowMs: 1000 });
  assert.equal(first.done, false, 'có mã ở nguồn đầu vẫn phải quét nốt nhóm SERP');
  const second = await runStep(JOB, first.checkpoint, driver, { nowMs: 1001 });
  assert.equal(second.done, true);
  assert.equal(second.reason, 'serp_batch_found');
  assert.deepEqual(driver.calls.source, ['retailmenot.com', 'couponfollow.com']);
});

test('CAPTCHA ở Google: dừng ngay, chuyển needs_user, KHÔNG thử lại', async () => {
  const driver = makeDriver({ serpByQuery: { '*': 'THROW_CAPTCHA' } });
  const result = await runStep(JOB, initialCheckpoint(JOB), driver, { nowMs: 1000 });
  assert.equal(result.done, true);
  assert.equal(result.result_status, 'needs_captcha');
  assert.equal(result.status, 'needs_user');
  assert.equal(driver.calls.search.length, 1, 'không được thử lại truy vấn sau CAPTCHA');
});

test('CAPTCHA ở nguồn giữ nguyên URL đầu hàng và không tiêu lượt nguồn', async () => {
  const source = {
    url: 'https://coupons.test/fitcamx', source_domain: 'coupons.test', search_query: 'q1',
  };
  const checkpoint = {
    ...initialCheckpoint(JOB), query_index: 1, queries_run: 1,
    batch_source_total: 1, pending_sources: [source],
  };
  const driver = {
    now: () => '2026-08-11T00:00:00Z',
    async readCouponSource() { return { challenge: 'captcha', blocks: [] }; },
    async reportCandidates() {},
  };
  const result = await runStep(JOB, checkpoint, driver, { nowMs: 1000 });
  assert.equal(result.status, 'needs_user');
  assert.equal(result.result_status, 'needs_captcha');
  assert.equal(result.checkpoint.sources_opened, 0);
  assert.equal(result.checkpoint.batch_source_done, 0);
  assert.deepEqual(result.checkpoint.pending_sources, [source]);
});

test('nguồn chặn cứng bị bỏ qua và runner tiếp tục nguồn Google kế tiếp', async () => {
  const blocked = { url: 'https://blocked.test/acme', source_domain: 'blocked.test', search_query: 'q1' };
  const next = { url: 'https://coupons.test/acme', source_domain: 'coupons.test', search_query: 'q1' };
  const checkpoint = {
    ...initialCheckpoint(JOB), query_index: 1, queries_run: 1,
    batch_source_total: 2, pending_sources: [blocked, next],
  };
  const driver = {
    now: () => '2026-08-11T00:00:00Z',
    async readCouponSource() { return { challenge: 'source_blocked', blocks: [] }; },
    async reportCandidates() {},
  };
  const result = await runStep(JOB, checkpoint, driver, { nowMs: 1000 });
  assert.equal(result.done, false);
  assert.equal(result.stage, 'skip-blocked:blocked.test');
  assert.equal(result.checkpoint.sources_opened, 1);
  assert.deepEqual(result.checkpoint.pending_sources, [next]);
});

test('người dùng bỏ trang đang treo: giữ mã cũ và tiếp tục đúng nguồn kế tiếp', async () => {
  const stuck = { url: 'https://stuck.test/acme', source_domain: 'stuck.test', search_query: 'q1' };
  const next = { url: 'https://coupons.test/acme', source_domain: 'coupons.test', search_query: 'q1' };
  const existing = { code: 'OLD20', normalized_code: 'OLD20', offer_text: 'Save 20% today' };
  const checkpoint = {
    ...initialCheckpoint(JOB), query_index: 1, queries_run: 1, candidates: [existing],
    batch_source_total: 2, pending_sources: [stuck, next],
  };
  const driver = {
    now: () => '2026-08-11T00:00:00Z',
    async readCouponSource() { return { skipped: true }; },
    async reportCandidates() {},
  };
  const result = await runStep(JOB, checkpoint, driver, { nowMs: 1000 });
  assert.equal(result.done, false);
  assert.equal(result.stage, 'skip-user:stuck.test');
  assert.equal(result.checkpoint.sources_opened, 1);
  assert.deepEqual(result.checkpoint.pending_sources, [next]);
  assert.deepEqual(result.checkpoint.candidates, [existing]);
});

test('nguồn đòi đăng nhập: job sang needs_login, không tự điền form', async () => {
  const driver = makeDriver({ sources: { '*': '<html><body>Sign in to view this coupon code</body></html>' } });
  let checkpoint = initialCheckpoint(JOB);
  let result = await runStep(JOB, checkpoint, driver, { nowMs: 1000 });   // bước tìm kiếm
  result = await runStep(JOB, result.checkpoint, driver, { nowMs: 1001 }); // bước mở nguồn
  assert.equal(result.status, 'needs_login');
  assert.equal(result.error_code, 'LOGIN_REQUIRED');
  assert.equal(result.done, true);
});

test('nguồn chính thức của merchant tự xác nhận domain và lấy mã trong heading', async () => {
  const merchantJob = {
    ...JOB,
    merchant: { name: 'ASPHostPortal', domain: 'asphostportal.com', aliases: [] },
  };
  const html = `<html><head><title>ASPHostPortal.com - Promotions</title></head><body>
    <h2>Use Promo Code "FREEDOMAIN" for a free domain</h2>
    <h2>Use the Promo Code "DBSQL" and receive double SQL Server Space</h2>
  </body></html>`;
  const driver = makeDriver({ sources: { 'asphostportal.com': html } });
  const checkpoint = {
    ...initialCheckpoint(merchantJob), started_at_ms: 1000, query_index: 1, queries_run: 1,
    pending_sources: [{
      url: 'https://asphostportal.com/Hosting-Promotions', source_domain: 'asphostportal.com',
      is_merchant_site: true, search_query: '"ASPHostPortal" coupon code',
    }],
  };
  const result = await runStep(merchantJob, checkpoint, driver, { nowMs: 1001 });
  assert.deepEqual(result.checkpoint.candidates.map((candidate) => candidate.code).sort(), ['DBSQL', 'FREEDOMAIN']);
  assert.ok(result.checkpoint.candidates.every((candidate) => candidate.evidence.merchant_match === 'exact'));
});

test('nguồn lỗi tạm không giết job — bỏ qua nguồn đó rồi đi tiếp', async () => {
  const driver = makeDriver({ sources: {} });   // mọi nguồn đều ném ELEMENT_NOT_FOUND
  let checkpoint = initialCheckpoint(JOB);
  let result = await runStep(JOB, checkpoint, driver, { nowMs: 1000 });
  result = await runStep(JOB, result.checkpoint, driver, { nowMs: 1001 });
  assert.equal(result.done, false, 'lỗi tạm phải cho chạy tiếp');
  assert.equal(result.error_code, 'ELEMENT_NOT_FOUND');
  assert.equal(result.checkpoint.last_error.code, 'ELEMENT_NOT_FOUND');
});

test('người dùng dừng giữa chừng: kết thúc sạch, giữ nguyên mã đã thu', async () => {
  const driver = makeDriver({ sources: { 'retailmenot.com': fixture('source-visible-code.html') } });
  let result = await runStep(JOB, initialCheckpoint(JOB), driver, { nowMs: 1000 });
  result = await runStep(JOB, result.checkpoint, driver, { nowMs: 1001 });
  const found = result.checkpoint.candidates.length;
  const stopped = await runStep(JOB, result.checkpoint, driver, { nowMs: 1002, cancelled: true });
  assert.equal(stopped.done, true);
  assert.equal(stopped.reason, 'user_stopped');
  assert.equal(stopped.checkpoint.candidates.length, found, 'dừng không được mất mã đã thu');
});

test('không mở quá ngân sách nguồn của độ sâu quick', async () => {
  const quickJob = { ...JOB, search_depth: 'quick', target_count: 99 };
  const driver = makeDriver({ sources: { '*': fixture('source-deal-only.html') } });
  let checkpoint = initialCheckpoint(quickJob);
  let last;
  for (let i = 0; i < 40; i += 1) {
    last = await runStep(quickJob, checkpoint, driver, { nowMs: 1000 + i });
    checkpoint = last.checkpoint;
    if (last.done) break;
  }
  assert.equal(last.done, true);
  assert.ok(checkpoint.queries_run <= 2, `quick chỉ được 2 truy vấn, đã chạy ${checkpoint.queries_run}`);
  assert.ok(checkpoint.sources_opened <= 5, `quick chỉ được 5 nguồn, đã mở ${checkpoint.sources_opened}`);
  assert.equal(last.result_status, 'no_results');
});

test('mở nhầm merchant: mã bị loại, job không nhận rác', async () => {
  const driver = makeDriver({ sources: { '*': fixture('source-wrong-merchant.html') } });
  let result = await runStep(JOB, initialCheckpoint(JOB), driver, { nowMs: 1000 });
  result = await runStep(JOB, result.checkpoint, driver, { nowMs: 1001 });
  assert.equal(result.checkpoint.candidates.length, 0);
  assert.ok(result.checkpoint.dropped > 0, 'phải đếm số bị loại, không im lặng bỏ');
});

test('tiếp tục sau khi service worker chết: nạp lại checkpoint và chạy tiếp không mất mã', async () => {
  const driver = makeDriver({
    sources: {
      'retailmenot.com': fixture('source-visible-code.html'),
      'couponfollow.com': fixture('source-reveal-button.html'),
    },
  });
  let result = await runStep(JOB, initialCheckpoint(JOB), driver, { nowMs: 1000 });
  result = await runStep(JOB, result.checkpoint, driver, { nowMs: 1001 });
  const beforeCrash = result.checkpoint.candidates.length;
  assert.ok(beforeCrash > 0);

  // Mô phỏng SW chết: chỉ còn checkpoint đã tuần tự hoá lưu ở storage.
  const persisted = JSON.parse(JSON.stringify(result.checkpoint));
  const resumed = restoreCheckpoint(JOB, persisted);
  assert.equal(resumed.candidates.length, beforeCrash, 'mã đã thu phải sống sót');
  const after = await runStep(JOB, resumed, driver, { nowMs: 1002 });
  assert.ok(after.checkpoint.candidates.length >= beforeCrash, 'chạy tiếp không được làm mất mã cũ');
  assert.ok(after.checkpoint.queries_run >= resumed.queries_run);
});
