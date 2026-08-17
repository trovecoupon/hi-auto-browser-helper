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

export function agentSessionState(session, now = Date.now()) {
  if (!session?.helper_token) return 'unpaired';
  const expiresAt = Date.parse(session.expires_at || '');
  if (!Number.isFinite(expiresAt) || now >= expiresAt) return 'expired';
  return 'connected';
}
