/**
 * Máy bước của một job Coupon Discovery. THUẦN: mọi tác động ra ngoài (mở tab, đọc trang, gọi API)
 * đi qua `driver` được tiêm vào, nên chạy test được đầy đủ ngoài trình duyệt.
 *
 * Bất biến:
 * - Mỗi bước kết thúc bằng một checkpoint LƯU ĐƯỢC → service worker chết vẫn chạy tiếp được.
 * - CAPTCHA / cần đăng nhập KHÔNG bao giờ tự thử lại.
 * - Không bao giờ vượt ngân sách truy vấn/nguồn/thời gian.
 */

import { AdapterError, ERROR_TO_STATUS, isHumanHeld } from './adapter-registry.mjs';
import { dedupeCandidates, evaluateBlocks } from './coupon-codes.mjs';
import { budgetFor, buildQueries, buildSearchUrl, selectSourcesToOpen } from './coupon-queries.mjs';

export const STEPS = Object.freeze(['plan', 'search', 'open_sources', 'finish']);
export const MIN_USEFUL_COUPONS = 1;
export const MAX_COUPONS_PER_JOB = 10;
export const SOURCES_PER_SERP = 5;

export function hasUsefulOfferTitle(candidate) {
  const title = String(candidate?.offer_text ?? candidate?.title ?? '').replace(/\s+/g, ' ').trim();
  if (title.length < 4 || title.length > 160) return false;
  const code = String(candidate?.normalized_code ?? candidate?.code ?? '').replace(/\s+/g, '').toUpperCase();
  if (title.replace(/\s+/g, '').toUpperCase() === code) return false;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const remainder = title
    .replace(/\b(?:use|apply|enter|with)?\s*(?:coupon|promo|promotion|discount|voucher)?\s*code\b/ig, ' ')
    .replace(new RegExp(escaped, 'ig'), ' ').replace(/[^\p{L}\p{N}%$€£]+/gu, '');
  if (remainder.length < 4) return false;
  if (/\b(?:expired|hết hạn)\b/i.test(title)) return false;
  return !/^(?:coupon|promo|promotion|discount|voucher|offer|deal)(?:\s+code)?[:\s-]*$/i.test(title);
}

function preferTitled(existing, incoming) {
  const old = Array.isArray(existing) ? existing : [];
  const fresh = Array.isArray(incoming) ? incoming : [];
  const oldTitled = old.filter(hasUsefulOfferTitle);
  const freshTitled = fresh.filter(hasUsefulOfferTitle);
  const pool = freshTitled.length || oldTitled.length
    ? [...oldTitled, ...freshTitled]
    : [...old, ...fresh];
  const kept = dedupeCandidates(pool).candidates.slice(0,
    freshTitled.length || oldTitled.length ? MAX_COUPONS_PER_JOB : 1);
  const keptCodes = new Set(kept.map((item) => item.normalized_code));
  return {
    candidates: kept,
    report: (freshTitled.length || oldTitled.length ? freshTitled : fresh)
      .filter((item) => keptCodes.has(item.normalized_code)),
  };
}

/** Checkpoint rỗng cho một job mới. Luôn tuần tự hoá được (JSON thuần). */
export function initialCheckpoint(job) {
  const plan = buildQueries({
    merchant: job.merchant,
    market: job.market,
    searchDepth: job.search_depth,
    preferredSources: job.preferred_sources,
  });
  return {
    step: 'search',
    queries: plan.queries,
    query_index: 0,
    queries_run: 0,
    sources_opened: 0,
    visited_domains: [],
    pending_sources: [],
    candidates: [],
    dropped: 0,
    current_query: null,
    current_source_domain: null,
    current_source_url: null,
    batch_source_total: 0,
    batch_source_done: 0,
    started_at_ms: null,
    last_error: null,
  };
}

export function restoreCheckpoint(job, saved) {
  const base = initialCheckpoint(job);
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.queries) || !saved.queries.length) return base;
  return {
    ...base,
    ...saved,
    queries: saved.queries,
    candidates: Array.isArray(saved.candidates) ? saved.candidates : [],
    visited_domains: Array.isArray(saved.visited_domains) ? saved.visited_domains : [],
    pending_sources: Array.isArray(saved.pending_sources) ? saved.pending_sources : [],
  };
}

function elapsed(checkpoint, nowMs) {
  // Kiểm tra hữu hạn chứ không kiểm tra truthy: mốc 0 là thời điểm hợp lệ, không phải "chưa đặt".
  return Number.isFinite(checkpoint?.started_at_ms)
    ? Math.max(0, nowMs - checkpoint.started_at_ms) : 0;
}

/**
 * Đánh giá điều kiện dừng SAU mỗi bước. Trả `null` nếu còn phải chạy tiếp.
 * Tách riêng để test được từng nhánh mà không cần chạy cả job.
 */
export function evaluateStop(job, checkpoint, { nowMs = 0, cancelled = false, blocked = null } = {}) {
  const budget = budgetFor(job.search_depth);
  if (cancelled) return { result_status: 'completed', reason: 'user_stopped' };
  if (blocked === 'captcha') return { result_status: 'needs_captcha', reason: 'captcha', error_code: 'CAPTCHA_REQUIRED' };
  if (blocked === 'google_blocked') return { result_status: 'google_blocked', reason: 'google_blocked', error_code: 'RATE_LIMITED' };
  if (blocked === 'source_blocked') return { result_status: 'source_blocked', reason: 'source_blocked', error_code: 'RATE_LIMITED' };
  if (checkpoint.candidates.length >= MAX_COUPONS_PER_JOB
      && checkpoint.candidates.some(hasUsefulOfferTitle)) {
    return { result_status: 'candidates_found', reason: 'coupon_cap_reached' };
  }
  // Quét hết tối đa 5 nguồn của SERP hiện tại rồi dừng ngay khi đã có ít nhất một mã. Chỉ chạy
  // truy vấn khác khi cả batch vừa quét không thu được mã nào.
  if (checkpoint.queries_run > 0 && !checkpoint.pending_sources.length
      && checkpoint.candidates.filter(hasUsefulOfferTitle).length >= MIN_USEFUL_COUPONS) {
    return { result_status: 'candidates_found', reason: 'serp_batch_found' };
  }
  if (elapsed(checkpoint, nowMs) >= budget.timeBudgetMs) return finishedBudget(checkpoint, 'time_budget');
  if (checkpoint.sources_opened >= budget.sources && !checkpoint.pending_sources.length
      && checkpoint.query_index >= checkpoint.queries.length) return finishedBudget(checkpoint, 'source_budget');
  if (checkpoint.query_index >= checkpoint.queries.length && !checkpoint.pending_sources.length) {
    return finishedBudget(checkpoint, 'query_budget');
  }
  return null;
}

function finishedBudget(checkpoint, reason) {
  return {
    result_status: checkpoint.candidates.length ? 'candidates_found' : 'no_results',
    reason,
  };
}

/**
 * Chạy đúng MỘT bước. Trả `{checkpoint, status, done, result_status, error_code}`.
 * Người gọi lưu checkpoint rồi mới gọi bước kế — nên mất điện giữa chừng không mất tiến độ.
 */
export async function runStep(job, checkpoint, driver, { nowMs = Date.now(), cancelled = false } = {}) {
  const budget = budgetFor(job.search_depth);
  const state = { ...checkpoint, started_at_ms: checkpoint.started_at_ms ?? nowMs };

  const early = evaluateStop(job, state, { nowMs, cancelled });
  if (early) return done(state, early);

  // Ưu tiên vét hết nguồn đang chờ trước khi chạy truy vấn mới: mở nguồn mới rẻ hơn tìm kiếm mới.
  if (state.pending_sources.length) {
    if (state.sources_opened >= budget.sources) {
      state.pending_sources = [];
      return { checkpoint: state, status: 'running', done: false, stage: 'source_budget_reached' };
    }
    const next = state.pending_sources.shift();
    state.current_source_domain = next.source_domain;
    state.current_source_url = next.url;
    let outcome;
    try {
      outcome = await driver.readCouponSource(next, job);
    } catch (error) {
      if (isHumanHeld(error?.code)) state.pending_sources.unshift(next);
      return handleError(state, error, 'reading_source');
    }
    if (outcome?.skipped) {
      // Người dùng chủ động bỏ đúng website đang treo. Đây vẫn được tính là một nguồn đã xem,
      // nhưng không kết thúc dự án và tuyệt đối không làm mất các coupon đã gom trước đó.
      state.sources_opened += 1;
      state.batch_source_done += 1;
      state.visited_domains = [...new Set([...state.visited_domains, next.source_domain])];
      state.last_error = {
        code: 'SOURCE_SKIPPED',
        message: `${next.source_domain} bị bỏ qua theo yêu cầu; đang chuyển sang nguồn kế tiếp.`,
        stage: 'reading_source',
      };
      state.current_source_domain = null;
      state.current_source_url = null;
      return { checkpoint: state, status: 'running', done: false, stage: `skip-user:${next.source_domain}` };
    }
    if (outcome?.challenge) {
      if (outcome.challenge === 'captcha') {
        // CAPTCHA/Cloudflare tương tác chưa phải là một nguồn đã quét. Giữ nguyên URL ở đầu checkpoint
        // để người dùng giải xong thì Resume đọc lại đúng trang này.
        state.pending_sources.unshift(next);
        return done(state, evaluateStop(job, state, { nowMs, blocked: 'captcha' }));
      }
      // Nguồn chặn cứng (Access denied/rate limit) không thể xử lý bằng checkbox: ghi nhận rồi bỏ đúng
      // nguồn này, tiếp tục các kết quả Google còn lại thay vì kết thúc cả dự án.
      state.sources_opened += 1;
      state.batch_source_done += 1;
      state.visited_domains = [...new Set([...state.visited_domains, next.source_domain])];
      state.last_error = { code: 'SOURCE_BLOCKED', message: `${next.source_domain} chặn truy cập; đã chuyển nguồn khác.`, stage: 'reading_source' };
      state.current_source_domain = null;
      state.current_source_url = null;
      return { checkpoint: state, status: 'running', done: false, stage: `skip-blocked:${next.source_domain}` };
    }
    if (outcome?.login_wall) {
      // Giữ nguồn ở đầu hàng để sau khi người dùng đăng nhập, nút Tiếp tục đọc lại đúng trang này.
      state.pending_sources.unshift(next);
      return handleError(state, new AdapterError('LOGIN_REQUIRED', `Nguồn ${next.source_domain} yêu cầu đăng nhập.`), 'reading_source');
    }
    state.sources_opened += 1;
    state.batch_source_done += 1;
    state.visited_domains = [...new Set([...state.visited_domains, next.source_domain])];
    const pageMerchant = next.is_merchant_site ? {
      ...(outcome?.merchant ?? {}),
      domains: [...new Set([...(outcome?.merchant?.domains ?? []), new URL(next.url).hostname])],
    } : outcome?.merchant;
    const evaluated = evaluateBlocks(outcome?.blocks ?? [], {
      merchant: job.merchant,
      pageMerchant,
      existingCodes: [...(job.existing_codes ?? []), ...state.candidates.map((c) => c.normalized_code)],
      sourceUrl: next.url,
      searchQuery: next.search_query ?? null,
      collectedAt: driver.now?.() ?? null,
    });
    state.dropped += evaluated.dropped.length;
    const preferred = preferTitled(state.candidates, evaluated.candidates);
    const newlyAccepted = preferred.report;
    state.candidates = preferred.candidates;
    if (newlyAccepted.length) await driver.reportCandidates(newlyAccepted);
    state.current_source_domain = null;
    state.current_source_url = null;
    const stop = evaluateStop(job, state, { nowMs });
    return stop ? done(state, stop) : { checkpoint: state, status: 'running', done: false, stage: `read:${next.source_domain}` };
  }

  // Không còn nguồn chờ → chạy truy vấn kế tiếp.
  if (state.query_index >= state.queries.length) {
    return done(state, finishedBudget(state, 'query_budget'));
  }
  const query = state.queries[state.query_index];
  state.current_query = query;
  let serp;
  try {
    serp = await driver.runSearch(buildSearchUrl(query, job.market), query, job);
  } catch (error) {
    return handleError(state, error, 'searching');
  }
  state.query_index += 1;
  state.queries_run += 1;
  if (serp?.challenge) {
    // CAPTCHA được người dùng giải trên chính truy vấn hiện tại. Giữ query này làm checkpoint kế
    // tiếp để Resume nạp lại kết quả đã mở, thay vì âm thầm bỏ qua sang query sau.
    if (serp.challenge === 'captcha') state.query_index = Math.max(0, state.query_index - 1);
    return done(state, evaluateStop(job, state, { nowMs, blocked: serp.challenge === 'captcha' ? 'captcha' : 'google_blocked' }));
  }

  // Mã lộ ngay trong snippet — thu luôn, nhưng vẫn phải qua đúng bộ lọc/chấm điểm.
  if (serp?.snippet_blocks?.length) {
    const fromSnippets = evaluateBlocks(serp.snippet_blocks, {
      merchant: job.merchant,
      pageMerchant: serp.page_merchant ?? { names: [], domains: [] },
      existingCodes: [...(job.existing_codes ?? []), ...state.candidates.map((c) => c.normalized_code)],
      sourceUrl: serp.snippet_source_url ?? `https://www.google.com/search`,
      searchQuery: query,
      collectedAt: driver.now?.() ?? null,
    });
    state.dropped += fromSnippets.dropped.length;
    const preferred = preferTitled(state.candidates, fromSnippets.candidates);
    const newlyAccepted = preferred.report;
    state.candidates = preferred.candidates;
    if (newlyAccepted.length) await driver.reportCandidates(newlyAccepted);
  }

  const selection = selectSourcesToOpen(serp?.results ?? [], {
    merchant: job.merchant,
    allowedSources: job.preferred_sources?.length ? job.preferred_sources : undefined,
    limit: Math.min(SOURCES_PER_SERP, Math.max(0, budget.sources - state.sources_opened)),
    visited: state.visited_domains,
  });
  state.pending_sources = selection.open.map((item) => ({ ...item, search_query: query }));
  state.batch_source_total = state.pending_sources.length;
  state.batch_source_done = 0;

  const stop = evaluateStop(job, state, { nowMs });
  return stop ? done(state, stop) : { checkpoint: state, status: 'running', done: false, stage: `search:${state.queries_run}` };
}

function done(checkpoint, stop) {
  const held = stop.result_status === 'needs_captcha';
  return {
    checkpoint: { ...checkpoint, step: held ? checkpoint.step : 'finish' },
    status: held ? 'needs_user' : 'saving',
    done: true,
    result_status: stop.result_status,
    reason: stop.reason,
    error_code: stop.error_code ?? null,
  };
}

function handleError(checkpoint, error, stage) {
  const wrapped = error instanceof AdapterError ? error : new AdapterError(error?.code, error?.message);
  const status = ERROR_TO_STATUS[wrapped.code] ?? 'running';
  const next = { ...checkpoint, last_error: { code: wrapped.code, message: wrapped.message, stage } };
  if (isHumanHeld(wrapped.code)) {
    return { checkpoint: next, status, done: true, result_status: wrapped.code === 'CAPTCHA_REQUIRED' ? 'needs_captcha' : 'needs_review', error_code: wrapped.code, reason: 'human_required' };
  }
  if (status === 'failed') {
    return { checkpoint: next, status, done: true, result_status: 'failed', error_code: wrapped.code, reason: 'connection_lost' };
  }
  // Lỗi tạm — bỏ qua bước này, đi tiếp; ngân sách vẫn chặn vòng lặp vô hạn.
  return { checkpoint: next, status: 'running', done: false, stage: `error:${wrapped.code}`, error_code: wrapped.code };
}
