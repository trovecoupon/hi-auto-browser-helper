/**
 * Adapter framework của Browser Helper 2.0.
 *
 * Mỗi website/quy trình là một adapter độc lập. Một adapter hỏng KHÔNG được kéo theo adapter khác:
 * mọi lời gọi đi qua `invoke()` có bọc lỗi, chuẩn hoá về `AdapterError` có mã cố định.
 *
 * Thuần — không chạm chrome.* — nên test được ngoài trình duyệt.
 */

export const PROTOCOL_VERSION = '2.0.0';

export const ERROR_CODES = Object.freeze([
  'LOGIN_REQUIRED', 'CAPTCHA_REQUIRED', 'PAGE_CHANGED', 'ELEMENT_NOT_FOUND', 'WRONG_MERCHANT',
  'NO_RESULTS', 'RATE_LIMITED', 'PERMISSION_MISSING', 'USER_ACTION_REQUIRED', 'CONNECTION_LOST', 'JOB_CANCELLED',
]);
const ERROR_SET = new Set(ERROR_CODES);

/** Mã lỗi nào là "chờ người", không bao giờ tự retry (brief §2). */
export const HUMAN_ERROR_CODES = Object.freeze(['CAPTCHA_REQUIRED', 'LOGIN_REQUIRED', 'PERMISSION_MISSING', 'USER_ACTION_REQUIRED']);
const HUMAN_SET = new Set(HUMAN_ERROR_CODES);

/** Mã lỗi → trạng thái job. Quyết định ở một chỗ duy nhất để adapter không tự ý đặt trạng thái. */
export const ERROR_TO_STATUS = Object.freeze({
  LOGIN_REQUIRED: 'needs_login',
  CAPTCHA_REQUIRED: 'needs_user',
  PERMISSION_MISSING: 'needs_user',
  USER_ACTION_REQUIRED: 'needs_user',
  WRONG_MERCHANT: 'running',
  PAGE_CHANGED: 'running',
  ELEMENT_NOT_FOUND: 'running',
  NO_RESULTS: 'running',
  RATE_LIMITED: 'paused',
  CONNECTION_LOST: 'failed',
  JOB_CANCELLED: 'cancelled',
});

export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message ?? code);
    this.name = 'AdapterError';
    this.code = ERROR_SET.has(code) ? code : 'PAGE_CHANGED';
    this.details = details;
    this.retryable = !HUMAN_SET.has(this.code) && this.code !== 'JOB_CANCELLED';
  }
}

export const isHumanHeld = (code) => HUMAN_SET.has(code);

/** Các bước bắt buộc của giao diện adapter. `detect` và `start` là tối thiểu. */
const REQUIRED_HOOKS = ['detect', 'start'];
const OPTIONAL_HOOKS = ['preflight', 'runStep', 'collectResult', 'pause', 'resume', 'cleanup'];

export function createRegistry() {
  const adapters = new Map();
  const health = new Map();

  function register(adapter) {
    const name = String(adapter?.name ?? '').trim();
    if (!name) throw new Error('Adapter phải có name.');
    for (const hook of REQUIRED_HOOKS) {
      if (typeof adapter[hook] !== 'function') throw new Error(`Adapter ${name} thiếu hook bắt buộc: ${hook}`);
    }
    adapters.set(name, adapter);
    health.set(name, { name, healthy: true, failures: 0, last_error: null, disabled: false });
    return name;
  }

  function get(name) {
    const adapter = adapters.get(String(name));
    if (!adapter) throw new AdapterError('ELEMENT_NOT_FOUND', `Không có adapter tên "${name}".`);
    return adapter;
  }

  /** Adapter khả dụng cho một context — adapter hỏng ở lần trước bị loại khỏi danh sách, không xoá. */
  function available(context = {}) {
    const out = [];
    for (const [name, adapter] of adapters) {
      const state = health.get(name);
      if (state.disabled) continue;
      let detected = false;
      try { detected = Boolean(adapter.detect(context)); } catch (error) { markFailure(name, error); continue; }
      out.push({ name, detected, healthy: state.healthy, capabilities: adapter.capabilities ?? [] });
    }
    return out;
  }

  function markFailure(name, error) {
    const state = health.get(name);
    if (!state) return;
    state.failures += 1;
    state.healthy = false;
    state.last_error = { code: error?.code ?? 'PAGE_CHANGED', message: String(error?.message ?? error).slice(0, 200) };
    // Cách ly: adapter hỏng liên tiếp bị tắt để không kéo cả hàng đợi xuống.
    if (state.failures >= 3) state.disabled = true;
  }

  function markSuccess(name) {
    const state = health.get(name);
    if (!state) return;
    state.failures = 0;
    state.healthy = true;
    state.last_error = null;
  }

  /**
   * Gọi một hook của adapter với hàng rào lỗi. Hook không tồn tại → trả `{skipped:true}` chứ không ném,
   * để adapter đơn giản không phải cài đủ 8 hook.
   */
  async function invoke(name, hook, ...args) {
    if (!REQUIRED_HOOKS.includes(hook) && !OPTIONAL_HOOKS.includes(hook)) {
      throw new AdapterError('ELEMENT_NOT_FOUND', `Hook không hợp lệ: ${hook}`);
    }
    const adapter = get(name);
    if (typeof adapter[hook] !== 'function') return { ok: true, skipped: true, value: null };
    try {
      const value = await adapter[hook](...args);
      markSuccess(name);
      return { ok: true, skipped: false, value };
    } catch (error) {
      const wrapped = error instanceof AdapterError
        ? error
        : new AdapterError(error?.code, error?.message ?? 'Adapter lỗi không rõ nguyên nhân.', { adapter: name });
      markFailure(name, wrapped);
      return { ok: false, skipped: false, error: wrapped, value: null };
    }
  }

  function snapshot() {
    return [...health.values()].map((state) => ({ ...state }));
  }

  function reset(name) {
    const state = health.get(name);
    if (state) Object.assign(state, { healthy: true, failures: 0, last_error: null, disabled: false });
  }

  return { register, get, available, invoke, snapshot, reset, get size() { return adapters.size; } };
}

/** Handshake trả về cho Hi Auto (brief §3). */
export function buildHandshake({ extensionVersion, adapters = [], connectionState = 'disconnected', activeJob = null, queue = null } = {}) {
  return {
    extensionVersion: String(extensionVersion ?? 'unknown'),
    protocolVersion: PROTOCOL_VERSION,
    adapters: adapters.map((a) => (typeof a === 'string' ? { name: a } : { name: a.name, detected: Boolean(a.detected), healthy: a.healthy !== false })),
    connectionState,
    activeJob,
    queue,
  };
}
