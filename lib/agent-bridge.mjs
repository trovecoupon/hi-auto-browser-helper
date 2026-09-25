export const AGENT_BRIDGE_URL = 'http://127.0.0.1:8771';

export function normalizePairingCode(value) {
  const code = String(value ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) throw new Error('Mã ghép Local Agent phải gồm đúng 6 số.');
  return code;
}

function messageFrom(value, fallback) {
  return String(value?.message || value?.error || fallback || 'Local Agent không phản hồi.');
}

export async function bridgeRequest(fetchFn, path, { method = 'GET', token = '', body } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('Bridge fetch không khả dụng.');
  const route = String(path || '');
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Đường dẫn Local Agent không hợp lệ.');
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchFn(`${AGENT_BRIDGE_URL}${route}`, {
      method, headers, cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Không thấy Local Agent tại 127.0.0.1:8771. Hãy bật HiAuto_LocalAgent.');
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value?.ok === false) {
    const error = new Error(messageFrom(value, `Local Agent trả HTTP ${response.status}.`));
    error.code = value?.error_code || `http_${response.status}`;
    throw error;
  }
  return value;
}

export function bridgeHealth(fetchFn = fetch) {
  return bridgeRequest(fetchFn, '/health');
}

export function pairWithAgent(code, fetchFn = fetch) {
  return bridgeRequest(fetchFn, '/v1/pair', {
    method: 'POST', body: { code: normalizePairingCode(code) },
  });
}

// VA 2026-08-20: tool 1 người dùng — extension cùng máy tự ghép với Agent,
// không cần mã 6 số (Agent từ bản vá 20/08 mở /v1/auto-pair cho origin
// chrome-extension://). Agent bản cũ trả 404 → caller rơi về màn nhập mã.
export function autoPairWithAgent(fetchFn = fetch) {
  return bridgeRequest(fetchFn, '/v1/auto-pair', { method: 'POST', body: {} });
}

export function claimAgentJob(token, fetchFn = fetch) {
  return bridgeRequest(fetchFn, '/v1/jobs/claim', {
    method: 'POST', token, body: {},
  });
}

export function completeAgentJob(jobId, token, result, fetchFn = fetch) {
  return bridgeRequest(fetchFn, `/v1/jobs/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST', token, body: result,
  });
}

// CC-55 (CC-51-F02): Agent cho job extension lease 90 s (ledger claim_local_job/heartbeat_local_job) và chỉ
// gia hạn khi lease còn hạn. Extension trước đây không gửi heartbeat → job chạy quá 90 s bị profile Chrome
// khác nhận lại và chạy trùng. Nhịp 30 s = còn hai lần thử trước khi lease hết.
export const AGENT_JOB_HEARTBEAT_MS = 30_000;
const AGENT_LEASE_LOST_CODES = new Set(['local_lease_invalid', 'pairing_invalid', 'pairing_required']);

export function heartbeatAgentJob(jobId, token, fetchFn = fetch) {
  return bridgeRequest(fetchFn, `/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`, {
    method: 'POST', token, body: {},
  });
}

// Giữ lease trong lúc job chạy. Lỗi mạng tạm (Agent khởi động lại) → thử lại ở nhịp sau; Agent trả lease
// sai/hết hạn hoặc phiên ghép bị huỷ → `lost` (job có thể đã được phiên khác nhận lại). Gọi stop() khi xong.
export function keepAgentJobLease(jobId, token, {
  fetchFn = fetch, intervalMs = AGENT_JOB_HEARTBEAT_MS,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  let lost = null; let stopped = false; let inFlight = false;
  const timer = setIntervalFn(() => {
    if (stopped || lost || inFlight) return;
    inFlight = true;
    heartbeatAgentJob(jobId, token, fetchFn)
      .catch((error) => {
        if (stopped || !AGENT_LEASE_LOST_CODES.has(error?.code)) return;
        lost = error; clearIntervalFn(timer);
      })
      .finally(() => { inFlight = false; });
  }, intervalMs);
  return {
    get lost() { return lost; },
    stop() { stopped = true; clearIntervalFn(timer); },
  };
}

export async function localApiViaAgent(path, token, {
  method = 'GET', body = null, adsToken = '', fetchFn = fetch,
} = {}) {
  const value = await bridgeRequest(fetchFn, '/v1/api', {
    method: 'POST', token, body: { path, method, body, ads_token: adsToken || null },
  });
  if (!Number.isInteger(value.status) || value.status < 200 || value.status >= 300) {
    const detail = value.data?.detail;
    const error = new Error(detail?.message || detail || value.data?.message
      || `Hi Auto local API returned HTTP ${value.status}.`);
    error.status = value.status;
    error.code = detail?.code || value.data?.code || `http_${value.status}`;
    throw error;
  }
  return value.data ?? {};
}

export function agentSessionState(session) {
  // Server giữ phiên TRƯỢT (mỗi lần dùng tự gia hạn) nên expires_at lưu lúc ghép
  // không phải sự thật — đồng hồ cục bộ từng khai tử phiên còn sống, bắt user ghép
  // lại mã 6 số mỗi 30 phút. Chỉ server (pairing_invalid) mới có quyền kết liễu phiên.
  return session?.helper_token ? 'connected' : 'unpaired';
}
