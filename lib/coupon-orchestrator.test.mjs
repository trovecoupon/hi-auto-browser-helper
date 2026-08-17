import assert from 'node:assert/strict';
import test from 'node:test';

import { initialCheckpoint } from './coupon-job-runner.mjs';
import { createOrchestrator } from './coupon-orchestrator.mjs';

const JOB = Object.freeze({
  job_id: 'cdj_test',
  brand_name: 'Acme Hosting',
  provider_domain: 'acme.test',
  merchant: { name: 'Acme Hosting', domain: 'acme.test', aliases: [] },
  market: { country: 'US', language: 'en' },
  existing_codes: [],
  preferred_sources: [],
  target_count: 5,
  search_depth: 'quick',
  checkpoint: {},
});

function memoryStorage(seed = {}) {
  const values = { ...seed };
  return {
    values,
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
    },
    async set(patch) { Object.assign(values, patch); },
    async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key]; },
  };
}

function deps({ storage, api }) {
  return {
    storage,
    api,
    tabs: {
      async get(id) { return { id, status: 'complete', url: 'https://coupons.test/acme' }; },
      async update(id, patch) { return { id, status: 'complete', ...patch }; },
      async create(patch) { return { id: 91, status: 'complete', ...patch }; },
    },
    scripting: { async executeScript() { return [{ result: {
      ok: true,
      snapshot: {
        blocks: [], challenge: null, login_wall: true,
        merchant: { names: ['Acme Hosting'], domains: ['acme.test'] },
      },
    } }]; } },
    permissions: {
      async contains() { return true; },
      async request() { return true; },
    },
  };
}

test('claim lại dùng checkpoint bền vững từ backend thay vì chạy lại từ đầu', async () => {
  const savedCheckpoint = { ...initialCheckpoint(JOB), query_index: 1, queries_run: 1 };
  const storage = memoryStorage();
  const orchestrator = createOrchestrator(deps({
    storage,
    api: async (path) => {
      assert.equal(path, '/api/ads-miner/coupon-discovery/helper/claim');
      return { job: { ...JOB, checkpoint: savedCheckpoint } };
    },
  }));

  await orchestrator.claimNext();
  assert.equal(storage.values.coupon_checkpoint.query_index, 1);
  assert.equal(storage.values.coupon_checkpoint.queries_run, 1);
});

test('claim ưu tiên đúng job người dùng vừa bấm thay vì job cũ nhất trong hàng đợi', async () => {
  const storage = memoryStorage({ coupon_preferred_job_ids: ['cdj_newest', 'cdj_second'] });
  const paths = [];
  const orchestrator = createOrchestrator(deps({
    storage,
    api: async (path) => {
      paths.push(path);
      return { job: { ...JOB, job_id: 'cdj_newest' } };
    },
  }));

  await orchestrator.claimNext();
  assert.deepEqual(paths, ['/api/ads-miner/coupon-discovery/helper/claim?job_id=cdj_newest']);
  assert.deepEqual(storage.values.coupon_preferred_job_ids, ['cdj_second']);
  assert.equal(storage.values.coupon_job.job_id, 'cdj_newest');
});

test('reload extension vẫn khôi phục được job đang chờ quyền từ checkpoint backend', async () => {
  const checkpoint = { ...initialCheckpoint(JOB), query_index: 1, queries_run: 1,
    last_error: { code: 'PERMISSION_MISSING', stage: 'reading_source' } };
  const held = { ...JOB, status: 'needs_user', checkpoint };
  const storage = memoryStorage();
  const orchestrator = createOrchestrator(deps({ storage, api: async () => ({}) }));
  await orchestrator.restoreHeld(held);
  assert.equal(storage.values.coupon_job.job_id, JOB.job_id);
  assert.equal(storage.values.coupon_checkpoint.query_index, 1);
  assert.equal(storage.values.coupon_checkpoint.last_error.code, 'PERMISSION_MISSING');
});

test('resume mở ngay nguồn đang chờ trước khi chạy nền', async () => {
  const checkpoint = initialCheckpoint(JOB);
  checkpoint.pending_sources = [{ url: 'https://coupons.test/acme', source_domain: 'coupons.test' }];
  const storage = memoryStorage({ coupon_job: JOB, coupon_checkpoint: checkpoint });
  const opened = [];
  const base = deps({ storage, api: async () => ({}) });
  base.tabs.create = async (patch) => { opened.push(patch.url); return { id: 91, ...patch }; };
  const orchestrator = createOrchestrator(base);
  const prepared = await orchestrator.prepareResume();
  assert.equal(prepared.hostname, 'coupons.test');
  assert.deepEqual(opened, ['https://coupons.test/acme']);
});

test('resume chỉ focus tab CAPTCHA đã giữ, không reload URL người dùng vừa xử lý', async () => {
  const checkpoint = initialCheckpoint(JOB);
  checkpoint.pending_sources = [{ url: 'https://coupons.test/acme', source_domain: 'coupons.test' }];
  const storage = memoryStorage({ coupon_job: JOB, coupon_checkpoint: checkpoint, coupon_tab_id: 91 });
  const updates = [];
  const base = deps({ storage, api: async () => ({}) });
  base.tabs.get = async () => ({ id: 91, status: 'complete', url: 'https://coupons.test/acme' });
  base.tabs.update = async (id, patch) => { updates.push(patch); return { id, ...patch }; };
  const orchestrator = createOrchestrator(base);

  await orchestrator.prepareResume();
  assert.deepEqual(updates, [{ active: true }]);
});

test('bỏ nguồn bị chặn chỉ bỏ URL hiện tại, không hủy cả dự án', async () => {
  const first = { url: 'https://blocked.test/acme', source_domain: 'blocked.test' };
  const second = { url: 'https://coupons.test/acme', source_domain: 'coupons.test' };
  const checkpoint = initialCheckpoint(JOB);
  checkpoint.pending_sources = [first, second];
  checkpoint.batch_source_total = 2;
  const storage = memoryStorage({ coupon_job: { ...JOB, status: 'needs_user' }, coupon_checkpoint: checkpoint });
  const pushes = [];
  const orchestrator = createOrchestrator(deps({
    storage,
    api: async (path, options) => { pushes.push([path, options?.body]); return {}; },
  }));

  const result = await orchestrator.skipHeldSource();
  assert.equal(result.source_domain, 'blocked.test');
  assert.equal(result.remaining_sources, 1);
  assert.deepEqual(storage.values.coupon_checkpoint.pending_sources, [second]);
  assert.equal(storage.values.coupon_checkpoint.sources_opened, 1);
  assert.equal(pushes[0][1].status, 'running');
});

test('nút bỏ trang ngắt ngay content script đang treo và đóng tab nguồn đó', async () => {
  const source = { url: 'https://stuck.test/acme', source_domain: 'stuck.test' };
  const checkpoint = initialCheckpoint(JOB);
  checkpoint.pending_sources = [source, { url: 'https://next.test/acme', source_domain: 'next.test' }];
  const storage = memoryStorage({ coupon_job: JOB, coupon_checkpoint: checkpoint });
  const removed = [];
  const base = deps({ storage, api: async () => ({}) });
  base.tabs.remove = async (tabId) => { removed.push(tabId); };
  base.scripting.executeScript = async () => new Promise(() => {});
  const orchestrator = createOrchestrator({ ...base, sleep: async () => {} });

  const reading = orchestrator.driver.readCouponSource(source);
  await new Promise((resolve) => setTimeout(resolve, 550));
  const skipped = await orchestrator.skipCurrentSource();
  const outcome = await reading;

  assert.equal(outcome.skipped, true);
  assert.equal(skipped.source_domain, 'stuck.test');
  assert.equal(skipped.remaining_sources, 1);
  assert.deepEqual(removed, [91]);
  assert.equal(storage.values.coupon_tab_id, undefined);
});

test('quét mới bỏ checkpoint executor cũ để claim job thay thế', async () => {
  const storage = memoryStorage({
    coupon_job: JOB,
    coupon_checkpoint: { ...initialCheckpoint(JOB), query_index: 4 },
  });
  const orchestrator = createOrchestrator(deps({ storage, api: async () => ({}) }));
  await orchestrator.discardLocalRun();
  assert.equal(storage.values.coupon_job, undefined);
  assert.equal(storage.values.coupon_checkpoint, undefined);
});

test('login wall giữ job và nguồn đang đọc để người dùng tiếp tục đúng chỗ', async () => {
  const checkpoint = initialCheckpoint(JOB);
  checkpoint.started_at_ms = 1; // checkpoint cũ nhiều giờ không được biến thành time_budget khi resume
  checkpoint.pending_sources = [{
    url: 'https://coupons.test/acme', source_domain: 'coupons.test', search_query: 'acme coupon',
  }];
  const storage = memoryStorage({ coupon_job: JOB, coupon_checkpoint: checkpoint });
  const calls = [];
  const orchestrator = createOrchestrator(deps({
    storage,
    api: async (path, options = {}) => {
      calls.push({ path, body: options.body });
      if (path.endsWith('/complete')) return { job: { ...JOB, status: 'needs_login' } };
      return { job: JOB };
    },
  }));

  const outcome = await orchestrator.driveCurrentJob();
  assert.equal(outcome.held, true);
  assert.equal(storage.values.coupon_job.status, 'needs_login');
  assert.equal(storage.values.coupon_checkpoint.pending_sources.length, 1);
  assert.equal(storage.values.coupon_checkpoint.sources_opened, 0);
  assert.equal(storage.values.coupon_tab_id, 91, 'tab phải được giữ lại để người dùng xử lý login/CAPTCHA');
  assert.equal(calls.find((call) => call.path.endsWith('/complete')).body.error_code, 'LOGIN_REQUIRED');
});

test('Coupon Discovery đóng tab làm việc sau khi job kết thúc thành công', async () => {
  const checkpoint = initialCheckpoint(JOB);
  checkpoint.query_index = checkpoint.queries.length;
  const storage = memoryStorage({ coupon_job: JOB, coupon_checkpoint: checkpoint, coupon_tab_id: 91 });
  const removed = [];
  const base = deps({
    storage,
    api: async (path) => path.endsWith('/complete')
      ? { job: { ...JOB, status: 'completed' } } : { job: JOB },
  });
  base.tabs.remove = async (tabId) => { removed.push(tabId); };
  const orchestrator = createOrchestrator(base);

  const outcome = await orchestrator.driveCurrentJob();
  assert.equal(outcome.done, true);
  assert.deepEqual(removed, [91]);
  assert.equal(storage.values.coupon_tab_id, undefined);
});

test('hủy Coupon Discovery cũng đóng đúng tab làm việc đang được theo dõi', async () => {
  const storage = memoryStorage({ coupon_job: JOB, coupon_tab_id: 91 });
  const removed = [];
  const base = deps({ storage, api: async () => ({ ok: true }) });
  base.tabs.remove = async (tabId) => { removed.push(tabId); };
  const orchestrator = createOrchestrator(base);

  await orchestrator.cancelCurrent();
  assert.deepEqual(removed, [91]);
  assert.equal(storage.values.coupon_tab_id, undefined);
});

test('lỗi lưu trạng thái kết thúc không xóa job hay checkpoint cục bộ', async () => {
  const checkpoint = initialCheckpoint(JOB);
  checkpoint.query_index = checkpoint.queries.length;
  const storage = memoryStorage({ coupon_job: JOB, coupon_checkpoint: checkpoint });
  const orchestrator = createOrchestrator(deps({
    storage,
    api: async (path) => {
      if (path.endsWith('/complete')) throw new Error('relay disconnected');
      return { job: JOB };
    },
  }));

  await assert.rejects(() => orchestrator.driveCurrentJob(), /relay disconnected/);
  assert.equal(storage.values.coupon_job.job_id, JOB.job_id);
  assert.equal(storage.values.coupon_checkpoint.query_index, checkpoint.queries.length);
});

test('driveQueue hoàn tất job hiện tại rồi tự claim job kế tiếp và chống vòng chạy trùng', async () => {
  const checkpoint = initialCheckpoint(JOB);
  checkpoint.query_index = checkpoint.queries.length;
  const storage = memoryStorage({ coupon_job: JOB, coupon_checkpoint: checkpoint, coupon_tab_id: 91 });
  let completed = 0;
  let claimed = 0;
  const removed = [];
  const base = deps({
    storage,
    api: async (path) => {
      if (path.endsWith('/complete')) {
        completed += 1;
        return { job: { ...JOB, status: 'completed' } };
      }
      if (path.endsWith('/claim')) {
        assert.deepEqual(removed, [], 'giữ tab để có thể tái sử dụng trước khi biết hàng đợi đã hết');
        claimed += 1;
        return { job: null };
      }
      return { job: JOB };
    },
  });
  base.tabs.remove = async (tabId) => { removed.push(tabId); };
  const orchestrator = createOrchestrator(base);

  const [first, second] = await Promise.all([
    orchestrator.driveQueue({ maxJobs: 10 }),
    orchestrator.driveQueue({ maxJobs: 10 }),
  ]);
  assert.equal(first.processed, 1);
  assert.deepEqual(second, first);
  assert.equal(completed, 1, 'hai lần bấm không được hoàn tất cùng một job hai lần');
  assert.equal(claimed, 1, 'sau job đầu phải hỏi backend lấy job tiếp theo');
  assert.deepEqual(removed, [91], 'đóng tab một lần khi toàn bộ lượt chạy đã kết thúc');
});

test('sau khi job kết thúc Side Panel vẫn đọc được ứng viên gần nhất để người dùng duyệt', async () => {
  const storage = memoryStorage();
  const orchestrator = createOrchestrator(deps({
    storage,
    api: async (path) => {
      assert.equal(path, '/api/ads-miner/coupon-discovery/jobs?limit=1&with_candidates=true');
      return { items: [{
        ...JOB,
        candidates: [{ candidate_id: 7, code: 'SAVE20', status: 'discovered' }],
      }] };
    },
  }));

  const state = await orchestrator.currentState();
  assert.equal(state.job, null);
  assert.equal(state.recentJob.job_id, JOB.job_id);
  assert.equal(state.candidates[0].project_brand_name, JOB.brand_name);
  assert.equal(state.candidates[0].project_job_id, JOB.job_id);
});

test('job mới nhất không có mã thì Side Panel không lôi coupon của dự án cũ lên', async () => {
  const newest = { ...JOB, job_id: 'cdj_hyonix', brand_name: 'Hyonix', provider_domain: 'hyonix.com', candidates: [] };
  const older = { ...JOB, job_id: 'cdj_milesweb', brand_name: 'MilesWeb', provider_domain: 'milesweb.in',
    candidates: [{ candidate_id: 7, code: 'BLOGFAN10', status: 'accepted' }] };
  const orchestrator = createOrchestrator(deps({
    storage: memoryStorage(),
    api: async () => ({ items: [newest, older] }),
  }));

  const state = await orchestrator.currentState();
  assert.equal(state.recentJob.job_id, 'cdj_hyonix');
  assert.deepEqual(state.candidates, []);
});

test('backend đã completed thì xóa ngay snapshot running cục bộ', async () => {
  const storage = memoryStorage({ coupon_job: { ...JOB, status: 'running' }, coupon_checkpoint: {
    ...initialCheckpoint(JOB), query_index: 2, queries_run: 2,
  } });
  const orchestrator = createOrchestrator(deps({
    storage,
    api: async () => ({ job: { ...JOB, status: 'completed', checkpoint: {
      ...initialCheckpoint(JOB), query_index: 5, queries_run: 5,
    } }, candidates: [] }),
  }));
  const state = await orchestrator.currentState();
  assert.equal(state.job, null);
  assert.equal(state.recentJob.status, 'completed');
  assert.equal(storage.values.coupon_job, undefined);
});

test('trang nguồn được đọc thụ động và Harvester được bật mà không tự click hay đóng tab con', async () => {
  const storage = memoryStorage();
  const removed = [];
  const tabs = {
    async create(patch) { return { id: 21, status: 'complete', ...patch }; },
    async get(id) { return { id, status: 'complete', url: id === 22 ? 'https://coupons.test/revealed' : 'https://coupons.test/acme' }; },
    async update(id, patch) { return { id, status: 'complete', ...patch }; },
    async query() { return [{ id: 21 }, { id: 22, openerTabId: 21, url: 'https://coupons.test/revealed' }]; },
    async remove(id) { removed.push(id); },
  };
  const scripting = {
    async executeScript({ target, files }) {
      assert.equal(target.tabId, 21);
      assert.deepEqual(files, ['content/coupon-source-read.js']);
      return [{ result: { ok: true, snapshot: {
        blocks: [{ code: 'ACME20', method: 'labelled_text' }], merchant: { names: ['Acme Hosting'], domains: [] },
      } } }];
    },
  };
  const started = [];
  const harvester = {
    async start(tabId) { started.push(tabId); },
    async snapshot() { return { blocks: [] }; },
  };
  const orchestrator = createOrchestrator({
    ...deps({ storage, api: async () => ({}) }), tabs, scripting,
    harvester,
    permissions: { async contains() { return true; }, async request() { return true; } },
  });

  const result = await orchestrator.driver.readCouponSource({ url: 'https://coupons.test/acme' });
  assert.equal(result.blocks[0].code, 'ACME20');
  assert.deepEqual(started, [21]);
  assert.deepEqual(removed, []);
  assert.equal(storage.values.coupon_tab_id, 21);
});

test('website nguồn giữ history không thể treo job: chuyển URL bằng tab sạch rồi đóng tab cũ', async () => {
  const storage = memoryStorage({ coupon_tab_id: 21, coupon_job: JOB });
  const created = [];
  const updated = [];
  const removed = [];
  const base = deps({ storage, api: async () => ({}) });
  base.tabs = {
    async get(id) { return { id, status: 'complete', url: 'https://simplero.com/' }; },
    async update(id, patch) { updated.push([id, patch]); return { id, ...patch }; },
    async create(patch) { created.push(patch); return { id: 22, status: 'complete', ...patch }; },
    async remove(id) { removed.push(id); },
  };
  base.scripting = { async executeScript() { return [{ result: { ok: true, snapshot: {
    blocks: [{ code: 'NEXT20', method: 'labelled_text' }], challenge: null, login_wall: false,
    merchant: { names: [], domains: [] },
  } } }]; } };
  const orchestrator = createOrchestrator({ ...base, sleep: async () => {} });

  await orchestrator.driver.readCouponSource({ url: 'https://coupons.test/acme' });

  assert.deepEqual(created, [{ url: 'https://coupons.test/acme', active: true }]);
  assert.deepEqual(updated, [], 'không gọi tabs.update trên tab Simplero bị giữ navigation');
  assert.deepEqual(removed, [21]);
  assert.equal(storage.values.coupon_tab_id, 22);
});

test('content script không phản hồi bị timeout để runner có thể chuyển nguồn khác', async () => {
  const storage = memoryStorage();
  const base = deps({ storage, api: async () => ({}) });
  base.scripting.executeScript = async () => new Promise(() => {});
  const orchestrator = createOrchestrator({ ...base, sourceScriptTimeoutMs: 5 });

  await assert.rejects(
    orchestrator.driver.readCouponSource({ url: 'https://coupons.test/acme' }),
    (error) => error?.code === 'PAGE_CHANGED' && /đã bỏ nguồn này/.test(error.message),
  );
});
