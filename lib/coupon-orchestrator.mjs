/**
 * Điều phối Coupon Discovery phía service worker.
 *
 * Tách khỏi `service-worker.js` để luồng Valentin/Ads Transparency đang chạy không bị đụng vào.
 * Mọi phụ thuộc chrome.* đi qua `deps` được tiêm, nên phần logic vẫn test được.
 *
 * Bất biến:
 * - Checkpoint được ĐẨY VỀ BACKEND sau MỖI bước → Chrome giết service worker vẫn chạy tiếp được.
 * - Chỉ một job chạy tại một thời điểm; backend giữ lease nên hai cửa sổ không giành nhau.
 * - Không bao giờ mở tab tới host chưa được cấp quyền; manifest production cấp quyền HTTPS cho adapter nguồn.
 */

import { AdapterError } from './adapter-registry.mjs';
import { initialCheckpoint, restoreCheckpoint, runStep } from './coupon-job-runner.mjs';
import { couponSnapshotFromHtml } from './coupon-parsers.mjs';

export const COUPON_STATE_KEYS = Object.freeze([
  'coupon_job', 'coupon_checkpoint', 'coupon_command', 'coupon_tab_id', 'coupon_paused',
  'coupon_preferred_job_ids',
]);

const SERP_WAIT_MS = 25_000;
const SOURCE_WAIT_MS = 30_000;
const AMBIGUOUS_SOURCE_GRACE_MS = 8_000;
const AMBIGUOUS_SOURCE_POLL_MS = 750;

/** Chrome API/content script đôi khi không trả callback khi trang giữ navigation/unload. */
async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AdapterError('PAGE_CHANGED', `Quá hạn ${label}; đã bỏ nguồn này.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Chờ một sự kiện do content script gửi về, có hạn. Hết hạn = PAGE_CHANGED, không treo mãi. */
function waiter(timeoutMs, label) {
  let settle;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AdapterError('PAGE_CHANGED', `Quá hạn chờ ${label}.`)), timeoutMs);
    settle = (value) => { clearTimeout(timer); resolve(value); };
  });
  return { promise, settle };
}

export function createOrchestrator(deps) {
  const {
    api,                    // (path, options) => Promise<data>  — relay qua tab Hi Auto
    storage,                // chrome.storage.session
    tabs,                   // chrome.tabs
    scripting,              // chrome.scripting
    permissions,            // chrome.permissions
    harvester = null,       // runtime capture; optional for unit tests
    notify = () => {},      // (payload) => void — đẩy trạng thái lên Side Panel
    now = () => new Date().toISOString(),
    searchPacingMs = 0,     // production đặt nhịp; test thuần để 0 để không phải sleep thật
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    navigationTimeoutMs = 12_000,
    sourceScriptTimeoutMs = 10_000,
    harvesterTimeoutMs = 5_000,
  } = deps;

  let pendingSerp = null;   // waiter đang chờ COUPON_SERP_RESULT
  let activeSourceScan = null; // lượt đọc nguồn có thể bị người dùng ngắt từ Side Panel
  let queueRun = null;      // khoá trong một vòng đời SW; backend lease là khoá xuyên vòng đời
  let nextSearchAt = 0;

  const read = () => storage.get(COUPON_STATE_KEYS);
  const write = (patch) => storage.set(patch);

  async function ensureWorkTab(url, { avoidReload = false, freshOnUrlChange = false } = {}) {
    const state = await read();
    if (state.coupon_tab_id) {
      try {
        // Xác minh tab CÒN TỒN TẠI trước khi dùng lại — service worker vừa khởi động lại có thể giữ id chết.
        const current = await bounded(tabs.get(state.coupon_tab_id), navigationTimeoutMs, 'kiểm tra tab làm việc');
        const sameUrl = stripHash(current?.url) === stripHash(url);
        // Không điều hướng RỜI một website nguồn trong chính tab đó: beforeunload/redirect của trang có
        // thể giữ tab mãi (đã gặp simplero.com). Mở tab sạch trước, đổi ownership rồi đóng tab cũ.
        // Resume đúng URL CAPTCHA vẫn tái sử dụng để không làm mất thao tác người dùng vừa xử lý.
        if (freshOnUrlChange && !sameUrl) {
          const replacement = await bounded(tabs.create({ url, active: true }), navigationTimeoutMs, 'mở tab sạch');
          await write({ coupon_tab_id: replacement.id });
          if (typeof tabs.remove === 'function') {
            try { await tabs.remove(state.coupon_tab_id); } catch { /* Trang/tab cũ đã tự đóng. */ }
          }
          return replacement.id;
        }
        await bounded(
          tabs.update(state.coupon_tab_id, avoidReload && sameUrl ? { active: true } : { url, active: true }),
          navigationTimeoutMs, 'điều hướng tab làm việc',
        );
        return state.coupon_tab_id;
      } catch { await storage.remove(['coupon_tab_id']); }
    }
    const tab = await bounded(tabs.create({ url, active: true }), navigationTimeoutMs, 'mở tab làm việc');
    await write({ coupon_tab_id: tab.id });
    return tab.id;
  }

  async function closeWorkTab() {
    const state = await read();
    const tabId = Number(state.coupon_tab_id);
    if (!Number.isInteger(tabId)) return false;
    await storage.remove(['coupon_tab_id']);
    if (typeof tabs.remove === 'function') {
      try { await tabs.remove(tabId); } catch { /* User/site already closed it. */ }
    }
    return true;
  }

  /** Quyền theo từng origin. Không có quyền → báo PERMISSION_MISSING, KHÔNG mở tab. */
  async function ensureOrigin(url) {
    const origin = `${new URL(url).origin}/*`;
    const granted = await permissions.contains({ origins: [origin] });
    if (granted) return true;
    throw new AdapterError('PERMISSION_MISSING', `Extension chưa có quyền cho ${new URL(url).hostname}; hãy reload extension.`);
  }

  const driver = {
    now,
    async runSearch(url, query, job) {
      const pacingWait = Math.max(0, nextSearchAt - Date.now());
      if (pacingWait) await sleep(pacingWait);
      nextSearchAt = Date.now() + Math.max(0, Number(searchPacingMs) || 0);
      await write({ coupon_command: { kind: 'search', job_id: job.job_id, query, requested_at: Date.now() } });
      const wait = waiter(SERP_WAIT_MS, 'trang kết quả Google');
      pendingSerp = { job_id: job.job_id, query, settle: wait.settle };
      await ensureWorkTab(url, { freshOnUrlChange: true });
      try {
        const payload = await wait.promise;
        if (payload.error_code) throw new AdapterError(payload.error_code, payload.error_message);
        return {
          challenge: payload.challenge ?? null,
          results: payload.results ?? [],
          snippet_blocks: payload.snippet_blocks ?? [],
          snippet_source_url: payload.snippet_source_url ?? null,
          page_merchant: { names: [], domains: [] },
        };
      } finally {
        pendingSerp = null;
        await storage.remove(['coupon_command']);
      }
    },

    async readCouponSource(target) {
      await ensureOrigin(target.url);
      // Nếu đây là lượt Resume sau CAPTCHA thì trang người dùng vừa giải xong đang ở đúng URL.
      // Không gán lại `url` vì thao tác đó reload challenge và làm mất công xử lý thủ công.
      const tabId = await ensureWorkTab(target.url, { avoidReload: true, freshOnUrlChange: true });
      const token = Symbol('source-scan');
      let settleSkip;
      const skipped = new Promise((resolve) => { settleSkip = resolve; });
      activeSourceScan = {
        token, tab_id: tabId, target,
        settle: () => settleSkip({ skipped: true, source_domain: target.source_domain }),
      };
      const scan = (async () => {
        await waitForTabIdle(tabs, tabId, SOURCE_WAIT_MS);
      if (harvester) {
        try {
          await bounded(harvester.start(tabId, { jobId: (await read()).coupon_job?.job_id ?? null }),
            harvesterTimeoutMs, 'bật bộ bắt mã');
        } catch { /* Bộ đọc DOM chính vẫn tiếp tục; Harvester chỉ là tầng bổ sung. */ }
      }
      let result = null;
      const graceDeadline = Date.now() + AMBIGUOUS_SOURCE_GRACE_MS;
      do {
        const [injected] = await bounded(scripting.executeScript({
          target: { tabId }, files: ['content/coupon-source-read.js'], world: 'ISOLATED',
        }), sourceScriptTimeoutMs, `đọc DOM ${new URL(target.url).hostname}`);
        result = injected?.result;
        if (!result || result.ok === false) break;
        const snapshot = result.snapshot;
        // Trang coupon thật hoặc challenge rõ ràng thì xử lý ngay. Chỉ chờ thêm khi DOM đang rỗng/mơ hồ,
        // đúng giai đoạn Cloudflare thường dựng widget sau `load`.
        if (snapshot?.challenge || snapshot?.login_wall || snapshot?.blocks?.length
            || result.manual_reveal_available || Date.now() >= graceDeadline) break;
        await sleep(AMBIGUOUS_SOURCE_POLL_MS);
      } while (Date.now() < graceDeadline);
      if (!result) throw new AdapterError('ELEMENT_NOT_FOUND', 'Không đọc được nội dung trang nguồn.');
      if (result.ok === false) throw new AdapterError(result.error_code, result.error_message);
      let runtime = { blocks: [] };
      if (harvester) {
        try {
          runtime = await bounded(harvester.snapshot(tabId, (await read()).coupon_job?.job_id ?? null),
            harvesterTimeoutMs, 'đọc dữ liệu bắt mã');
        } catch { /* Không để tầng bổ sung giữ cả hàng đợi. */ }
      }
      const snapshot = mergeSnapshots(result.snapshot ?? couponSnapshotFromHtml('', target.url), [{
        blocks: runtime.blocks ?? [], merchant: result.snapshot?.merchant ?? { names: [], domains: [] },
      }]);
      if (!snapshot.blocks?.length && result.manual_reveal_available) {
        throw new AdapterError('USER_ACTION_REQUIRED', 'Hãy tự bấm Show/Reveal/Copy code trên tab đang mở; Hi Auto sẽ tự bắt mã và chạy tiếp.');
      }
        return {
          blocks: snapshot.blocks ?? [],
          merchant: snapshot.merchant ?? { names: [], domains: [] },
          challenge: snapshot.challenge ?? null,
          login_wall: Boolean(snapshot.login_wall),
        };
      })();
      try {
        return await Promise.race([scan, skipped]);
      } finally {
        if (activeSourceScan?.token === token) activeSourceScan = null;
      }
    },

    async reportCandidates(candidates) {
      const state = await read();
      const jobId = state.coupon_job?.job_id;
      if (!jobId || !candidates.length) return;
      await api(`/api/ads-miner/coupon-discovery/helper/jobs/${jobId}/candidates`,
        { method: 'POST', body: { candidates } });
      notify({ log: `Đã gửi ${candidates.length} mã về Hi Auto.`, kind: 'ok' });
    },
  };

  /** Nhận kết quả SERP từ content script. Trả false nếu không ai đang chờ (trang lạc). */
  function acceptSerpResult(payload) {
    if (!pendingSerp || pendingSerp.job_id !== payload?.job_id) return false;
    pendingSerp.settle(payload);
    return true;
  }

  async function claimNext() {
    const state = await read();
    const preferred = Array.isArray(state.coupon_preferred_job_ids)
      ? state.coupon_preferred_job_ids.filter((jobId) => typeof jobId === 'string' && jobId)
      : [];
    const preferredJobId = preferred[0] ?? null;
    const claimPath = preferredJobId
      ? `/api/ads-miner/coupon-discovery/helper/claim?job_id=${encodeURIComponent(preferredJobId)}`
      : '/api/ads-miner/coupon-discovery/helper/claim';
    const claimed = await api(claimPath, { method: 'POST' });
    if (preferredJobId) {
      // Dù job ưu tiên vừa bị hủy/đã được phiên khác nhận và backend phải fallback, không thử ID
      // đã cũ mãi ở mọi lần claim sau. Các ID còn lại vẫn giữ đúng thứ tự người dùng vừa chọn.
      await write({ coupon_preferred_job_ids: preferred.slice(1) });
    }
    if (!claimed?.job) return null;
    // Job `ready` sau khi lease cũ hết hạn đã có checkpoint bền vững ở backend. Không được đưa nó
    // về đầu hàng chỉ vì storage.session của executor không còn.
    const checkpoint = restoreCheckpoint(claimed.job, claimed.job.checkpoint);
    await write({ coupon_job: claimed.job, coupon_checkpoint: checkpoint });
    notify({ log: `Nhận dự án: ${claimed.job.brand_name} (${claimed.job.provider_domain})`, kind: 'ok' });
    return claimed.job;
  }

  /** Khôi phục một job đang chờ người từ checkpoint backend sau khi extension vừa Reload/mất storage.session. */
  async function restoreHeld(job) {
    if (!job?.job_id || !['needs_user', 'needs_login', 'paused'].includes(job.status)) return null;
    const checkpoint = restoreCheckpoint(job, job.checkpoint);
    await write({ coupon_job: job, coupon_checkpoint: checkpoint });
    return job;
  }

  /** Chuẩn bị tab trước khi trả ACK cho nút Resume, để thao tác luôn có phản hồi nhìn thấy được. */
  async function prepareResume() {
    const state = await read();
    const job = state.coupon_job;
    if (!job) throw new AdapterError('CONNECTION_LOST', 'Không tìm thấy job đang chờ để chạy tiếp.');
    const checkpoint = restoreCheckpoint(job, state.coupon_checkpoint ?? job.checkpoint);
    const source = checkpoint.pending_sources[0];
    if (source?.url) {
      await ensureOrigin(source.url);
      const local = await read();
      let tabId = Number(local.coupon_tab_id);
      if (Number.isInteger(tabId)) {
        try {
          await tabs.get(tabId);
          await tabs.update(tabId, { active: true });
        } catch {
          await storage.remove(['coupon_tab_id']);
          tabId = await ensureWorkTab(source.url);
        }
      } else {
        tabId = await ensureWorkTab(source.url);
      }
      return { tab_id: tabId, hostname: new URL(source.url).hostname };
    }
    const tabId = Number(state.coupon_tab_id);
    if (Number.isInteger(tabId)) {
      await tabs.update(tabId, { active: true });
      return { tab_id: tabId, hostname: null };
    }
    throw new AdapterError('PAGE_CHANGED', 'Checkpoint không còn URL nguồn hoặc tab làm việc để chạy tiếp.');
  }

  /** Chạy job hiện tại tới khi kết thúc hoặc bị chặn. Mỗi bước đều đẩy checkpoint về backend. */
  async function driveCurrentJob({ maxSteps = 60, keepWorkTab = false } = {}) {
    const state = await read();
    const job = state.coupon_job;
    if (!job) return { done: true, reason: 'no_job' };
    let checkpoint = restoreCheckpoint(job, state.coupon_checkpoint);
    // timeBudget là thời gian quét CHỦ ĐỘNG, không phải thời gian extension ngủ/chờ người dùng.
    // Mỗi vòng drive mới (reload worker, resume CAPTCHA/quyền, reclaim lease) bắt đầu lại đồng hồ;
    // query/source budget trong checkpoint vẫn giữ nguyên nên không thể chạy vô hạn.
    checkpoint.started_at_ms = null;

    for (let step = 0; step < maxSteps; step += 1) {
      const live = await read();
      if (live.coupon_paused) {
        await push(job, checkpoint, { status: 'paused', stage: 'user_paused' });
        return { done: false, reason: 'paused' };
      }
      if (!live.coupon_job || live.coupon_job.job_id !== job.job_id) return { done: true, reason: 'job_changed' };

      const upcomingSource = checkpoint.pending_sources?.[0];
      if (upcomingSource) {
        notify({
          log: `Nguồn ${Math.min(checkpoint.batch_source_done + 1, checkpoint.batch_source_total || 5)}/${checkpoint.batch_source_total || 5}: đang quét ${upcomingSource.source_domain}${upcomingSource.serp_rank ? ` (kết quả Google #${upcomingSource.serp_rank})` : ''} · đã có ${checkpoint.candidates.length}/10 mã.`,
          kind: 'info',
        });
      } else if (checkpoint.queries?.[checkpoint.query_index]) {
        notify({
          log: `Google ${checkpoint.query_index + 1}/${checkpoint.queries.length}: ${checkpoint.queries[checkpoint.query_index]} · chỉ tìm tiếp vì hiện có ${checkpoint.candidates.length} mã.`,
          kind: 'info',
        });
      }

      let outcome;
      try {
        outcome = await runStep(job, checkpoint, driver, { nowMs: Date.now() });
      } catch (error) {
        const wrapped = error instanceof AdapterError ? error : new AdapterError(error?.code, error?.message);
        await push(job, checkpoint, { status: 'failed', stage: 'runner_error', error_code: wrapped.code, error_message: wrapped.message });
        await finish(job, 'failed', wrapped.code, wrapped.message, { keepWorkTab });
        return { done: true, reason: 'error' };
      }

      checkpoint = outcome.checkpoint;
      await write({ coupon_checkpoint: checkpoint });
      await push(job, checkpoint, {
        status: outcome.done ? undefined : 'running',
        stage: outcome.stage ?? outcome.reason ?? null,
        error_code: outcome.error_code ?? null,
      });

      if (outcome.done) {
        const completion = await finish(
          job, outcome.result_status, outcome.error_code, outcome.reason, { keepWorkTab },
        );
        return {
          done: true, held: completion.held, reason: outcome.reason,
          result_status: outcome.result_status,
        };
      }
      notify({});
    }
    await push(job, checkpoint, { status: 'paused', stage: 'step_limit' });
    return { done: false, reason: 'step_limit' };
  }

  async function push(job, checkpoint, extra = {}) {
    const body = {
      checkpoint,
      queries_run: checkpoint.queries_run ?? 0,
      sources_opened: checkpoint.sources_opened ?? 0,
      ...extra,
    };
    if (body.status === undefined) delete body.status;
    // Không nuốt lỗi lưu checkpoint. Nếu relay/backend mất kết nối, vòng chạy phải dừng và giữ
    // nguyên coupon_job + coupon_checkpoint trong storage.session để người dùng Resume an toàn.
    await api(`/api/ads-miner/coupon-discovery/helper/jobs/${job.job_id}/progress`, { method: 'POST', body });
  }

  async function finish(job, resultStatus, errorCode, reason, { keepWorkTab = false } = {}) {
    const completed = await api(`/api/ads-miner/coupon-discovery/helper/jobs/${job.job_id}/complete`, {
      method: 'POST',
      body: { result_status: resultStatus, error_code: errorCode ?? null, error_message: reason ?? null },
    });
    const held = ['needs_user', 'needs_login', 'paused'].includes(completed?.job?.status);
    if (held) {
      // CAPTCHA/login/permission không phải terminal: giữ checkpoint và cập nhật job để panel hiện
      // đúng hướng dẫn. Resume sẽ đi tiếp từ query/source vừa bị giữ.
      await write({ coupon_job: completed.job });
    } else {
      await storage.remove(['coupon_job', 'coupon_checkpoint', 'coupon_command']);
      if (!keepWorkTab) await closeWorkTab();
    }
    notify({
      log: held ? `${job.brand_name}: đang chờ bạn xử lý.` : `${job.brand_name}: ${resultStatus}`,
      kind: resultStatus === 'candidates_found' ? 'ok' : 'info',
    });
    return { held, job: completed?.job ?? null };
  }

  /** Chạy tuần tự nhiều job đã xếp. Một promise duy nhất ngăn hai cú bấm tạo hai executor trong SW. */
  async function driveQueue({ maxJobs = 25 } = {}) {
    if (queueRun) return queueRun;
    const active = (async () => {
      let processed = 0;
      while (processed < Math.max(1, Number(maxJobs) || 1)) {
        const state = await read();
        if (state.coupon_paused) return { done: false, reason: 'paused', processed };
        if (!state.coupon_job) {
          const claimed = await claimNext();
          if (!claimed) {
            await closeWorkTab();
            return { done: true, reason: 'queue_empty', processed };
          }
        }
        const outcome = await driveCurrentJob({ keepWorkTab: true });
        if (outcome.held || !outcome.done) return { ...outcome, processed };
        processed += 1;
      }
      await closeWorkTab();
      return { done: true, reason: 'batch_limit', processed };
    })();
    queueRun = active;
    try {
      return await active;
    } finally {
      if (queueRun === active) queueRun = null;
    }
  }

  async function cancelCurrent({ keepWorkTab = false, skipped = false } = {}) {
    const state = await read();
    if (!state.coupon_job) return { ok: true, message: 'Không có job nào đang chạy.' };
    await api(`/api/ads-miner/coupon-discovery/jobs/${state.coupon_job.job_id}/cancel`, { method: 'POST' });
    await storage.remove(['coupon_job', 'coupon_checkpoint', 'coupon_command']);
    if (!keepWorkTab) await closeWorkTab();
    return { ok: true, message: skipped ? 'Đã bỏ qua dự án hiện tại.' : 'Đã hủy job hiện tại.' };
  }

  async function discardLocalRun() {
    await storage.remove(['coupon_job', 'coupon_checkpoint', 'coupon_command', 'coupon_preferred_job_ids']);
    await closeWorkTab();
    if (queueRun) {
      try { await queueRun; } catch { /* Job backend cũ đã bị replace; đây là kết thúc mong đợi. */ }
    }
    return { ok: true };
  }

  async function setPreferredJobs(jobIds) {
    const preferred = [...new Set((Array.isArray(jobIds) ? jobIds : [])
      .filter((jobId) => typeof jobId === 'string' && jobId))];
    await write({ coupon_preferred_job_ids: preferred });
    return preferred;
  }

  /** Người dùng xác nhận nguồn đang giữ bị chặn thật: bỏ đúng nguồn, không hủy cả dự án. */
  async function skipHeldSource() {
    const state = await read();
    const job = state.coupon_job;
    if (!job?.job_id) throw new AdapterError('CONNECTION_LOST', 'Không có job đang chờ nguồn để bỏ qua.');
    const checkpoint = restoreCheckpoint(job, state.coupon_checkpoint ?? job.checkpoint);
    const source = checkpoint.pending_sources.shift();
    if (!source?.url) throw new AdapterError('PAGE_CHANGED', 'Job đang chờ Google, không có website nguồn nào để bỏ qua.');
    checkpoint.sources_opened += 1;
    checkpoint.batch_source_done += 1;
    checkpoint.visited_domains = [...new Set([...checkpoint.visited_domains, source.source_domain])];
    checkpoint.current_source_domain = null;
    checkpoint.current_source_url = null;
    checkpoint.last_error = {
      code: 'SOURCE_SKIPPED', message: `${source.source_domain} bị chặn; người dùng yêu cầu tìm nguồn khác.`,
      stage: 'reading_source',
    };
    await write({ coupon_checkpoint: checkpoint });
    await push(job, checkpoint, { status: 'running', stage: `skip-blocked:${source.source_domain}`, error_code: null });
    return { source_domain: source.source_domain, remaining_sources: checkpoint.pending_sources.length };
  }

  /** Ngắt nguồn đang được đọc ngay; nếu runner đang chờ người dùng thì dùng checkpoint đã giữ. */
  async function skipCurrentSource() {
    const active = activeSourceScan;
    if (!active) return skipHeldSource();
    const state = await read();
    const checkpoint = restoreCheckpoint(
      state.coupon_job,
      state.coupon_checkpoint ?? state.coupon_job?.checkpoint,
    );
    active.settle();
    await closeWorkTab();
    return {
      source_domain: active.target.source_domain ?? new URL(active.target.url).hostname,
      remaining_sources: Math.max(0, checkpoint.pending_sources.length - 1),
    };
  }

  async function currentState() {
    const state = await read();
    let job = state.coupon_job ?? null;
    let recentJob = null;
    let candidates = [];
    if (job) {
      try {
        const fresh = await api(`/api/ads-miner/coupon-discovery/helper/jobs/${job.job_id}`);
        candidates = fresh.candidates ?? [];
        if (['completed', 'failed', 'cancelled'].includes(fresh.job?.status)) {
          await storage.remove(['coupon_job', 'coupon_checkpoint', 'coupon_command']);
          recentJob = fresh.job;
          job = null;
        } else {
          job = { ...fresh.job, checkpoint: fresh.job.checkpoint ?? state.coupon_checkpoint };
        }
      } catch { /* Backend chưa với tới được — vẫn hiển thị trạng thái đang lưu ở máy. */ }
    } else {
      try {
        // Active job đã được dọn sau khi lưu bền vững, nhưng ứng viên vẫn phải ở lại Side Panel để
        // người dùng xem nguồn/chọn mã. Lấy tối đa 10 job gần nhất, không tự accept bất kỳ mã nào.
        const recent = await api('/api/ads-miner/coupon-discovery/jobs?limit=1&with_candidates=true');
        // Panel phản ánh đúng job mới nhất, kể cả job đó không tìm được mã. Không lục ngược các job cũ
        // có coupon vì sẽ khiến người dùng tưởng mã MilesWeb thuộc dự án Hyonix đang chạy.
        recentJob = recent?.items?.[0] ?? null;
        candidates = (recentJob?.candidates ?? []).map((candidate) => ({
          ...candidate,
          project_brand_name: recentJob.brand_name,
          project_domain: recentJob.provider_domain,
          project_job_id: recentJob.job_id,
        }));
      } catch { /* Chưa kết nối: panel vẫn hoạt động và sẽ thử lại ở nhịp refresh kế tiếp. */ }
    }
    return { job, recentJob, candidates, paused: Boolean(state.coupon_paused) };
  }

  return {
    driver, claimNext, restoreHeld, prepareResume, driveCurrentJob, driveQueue, cancelCurrent, discardLocalRun,
    setPreferredJobs, skipHeldSource, skipCurrentSource, currentState, acceptSerpResult, ensureOrigin,
    setPaused: (paused) => write({ coupon_paused: Boolean(paused) }),
  };
}

/** Chờ tab nạp xong. Không có sự kiện complete trong hạn thì vẫn đọc — trang có thể đã dùng được. */
async function waitForTabIdle(tabs, tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await bounded(tabs.get(tabId), 3_000, 'đọc trạng thái tab'); }
    catch { throw new AdapterError('PAGE_CHANGED', 'Tab làm việc đã bị đóng hoặc không phản hồi.'); }
    if (tab.status === 'complete') { await new Promise((r) => setTimeout(r, 500)); return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function stripHash(url) {
  try {
    const parsed = new URL(String(url || ''));
    parsed.hash = '';
    return parsed.href;
  } catch { return String(url || '').split('#')[0]; }
}

async function currentTabIds(tabs) {
  if (typeof tabs.query !== 'function') return null;
  try { return new Set((await tabs.query({})).map((tab) => tab.id)); } catch { return null; }
}

/**
 * Reveal đôi khi mở popup/tab mới. Chỉ đọc tab sinh trực tiếp từ tab nguồn, chỉ khi origin đó đã
 * được cấp quyền; không xin thêm quyền ngoài một thao tác người dùng. Mọi tab phụ đều được đóng sau
 * khi đọc để không chiếm quyền điều khiển của job.
 */
async function collectSpawnedSnapshots({ tabs, scripting, permissions, parentTabId, beforeTabs }) {
  if (!beforeTabs || typeof tabs.query !== 'function') return [];
  let after;
  try { after = await tabs.query({}); } catch { return []; }
  const spawned = after.filter((tab) => !beforeTabs.has(tab.id) && tab.openerTabId === parentTabId);
  const snapshots = [];
  for (const tab of spawned) {
    try {
      await waitForTabIdle(tabs, tab.id, SOURCE_WAIT_MS);
      const current = await tabs.get(tab.id);
      if (!/^https:\/\//.test(current.url ?? '')) continue;
      const origin = `${new URL(current.url).origin}/*`;
      if (!await permissions.contains({ origins: [origin] })) continue;
      const [injected] = await scripting.executeScript({
        target: { tabId: tab.id }, files: ['content/coupon-source-read.js'], world: 'ISOLATED',
      });
      if (injected?.result?.ok && injected.result.snapshot) snapshots.push(injected.result.snapshot);
    } catch { /* Tab phụ có thể tự đóng/chuyển origin; bỏ qua nhưng vẫn giữ job chính. */ }
    finally {
      if (typeof tabs.remove === 'function') {
        try { await tabs.remove(tab.id); } catch { /* Người dùng/site đã đóng trước. */ }
      }
    }
  }
  if (spawned.length) {
    try { await tabs.update(parentTabId, { active: true }); } catch { /* Tab nguồn đã bị đóng. */ }
  }
  return snapshots;
}

function mergeSnapshots(primary, extras) {
  const snapshots = [primary, ...(extras ?? [])].filter(Boolean);
  const blocks = new Map();
  const names = new Set();
  const domains = new Set();
  for (const snapshot of snapshots) {
    for (const block of snapshot.blocks ?? []) {
      const key = `${String(block.code ?? '').toUpperCase()}|${block.method ?? ''}`;
      if (!blocks.has(key)) blocks.set(key, block);
    }
    for (const name of snapshot.merchant?.names ?? []) names.add(name);
    for (const domain of snapshot.merchant?.domains ?? []) domains.add(domain);
  }
  return {
    ...primary,
    blocks: [...blocks.values()],
    merchant: { names: [...names], domains: [...domains] },
    challenge: snapshots.find((snapshot) => snapshot.challenge)?.challenge ?? null,
    login_wall: snapshots.some((snapshot) => snapshot.login_wall),
  };
}
