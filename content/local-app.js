(() => {
if (globalThis.__HI_AUTO_BROWSER_HELPER_BRIDGE__) return;
globalThis.__HI_AUTO_BROWSER_HELPER_BRIDGE__ = true;

let relayCsrf = null;
const HI_AUTO_CSRF_HEADER = 'X-Coupon-Tool-CSRF';

/**
 * Relay chỉ được gọi các đường dẫn thuộc Browser Helper. Không phải relay URL tuỳ ý:
 * - bắt buộc là đường dẫn tương đối cùng origin (chặn `//host`, `https://host`, `\\host`),
 * - phải khớp một tiền tố trong allowlist dưới đây.
 * Thêm tính năng mới = thêm đúng một tiền tố ở đây, có chủ đích.
 */
const RELAY_ALLOWED_PREFIXES = [
  '/api/ads-miner/discovery/helper/',
  '/api/ads-miner/coupon-discovery/helper/',
  '/api/ads-miner/coupon-discovery/jobs/',
  '/api/ads-miner/coupon-discovery/queue/',
  '/api/ads-miner/coupon-discovery/candidates/',
  '/api/demand/helper/',
  '/api/ads-miner/affiliate-helper/',
  '/api/trend-gate/traffic/',
];
const RELAY_ALLOWED_EXACT = new Set([
  '/api/ads-miner/coupon-discovery/jobs',
  '/api/ads-miner/coupon-discovery/projects',
  '/api/trend-gate/traffic',
]);
const RELAY_ALLOWED_METHODS = new Set(['GET', 'POST']);

function relayPath(value) {
  const path = String(value ?? '');
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return null;
  let resolved;
  try { resolved = new URL(path, location.origin); } catch { return null; }
  if (resolved.origin !== location.origin) return null;
  return (RELAY_ALLOWED_EXACT.has(resolved.pathname)
      || RELAY_ALLOWED_PREFIXES.some((prefix) => resolved.pathname.startsWith(prefix)))
    ? resolved.pathname + resolved.search : null;
}

function runtimeMessage(message, eventName) {
  // Một content script cũ có thể còn nằm trong tab vài mili-giây sau khi extension được Reload/Update.
  // Chrome ném lỗi đồng bộ trước khi callback tồn tại; bắt và im lặng để bản bridge mới tự được bơm lại.
  try {
    if (!chrome.runtime?.id) return;
    let finished = false;
    const finish = (detail) => {
      if (finished) return;
      finished = true;
      document.dispatchEvent(new CustomEvent(eventName, { detail }));
    };
    const pending = chrome.runtime.sendMessage(message, (response) => {
      let runtimeError = null;
      try { runtimeError = chrome.runtime?.lastError?.message ?? null; }
      catch { return; }
      if (/extension context invalidated/i.test(String(runtimeError || ''))) { finished = true; return; }
      const ok = !runtimeError && response?.ok === true;
      finish({
        ...(response ?? {}), ok, version: response?.version ?? null,
        error: runtimeError ?? response?.error ?? (!response ? 'Browser Helper did not respond. Reload the extension and this page.' : ok ? null : 'Browser Helper rejected the action.'),
      });
    });
    // Chrome mới có thể trả Promise ngay cả khi dùng callback. Context cũ sau Reload sẽ reject Promise;
    // nếu bỏ qua return value, Chrome ghi thành "Uncaught (in promise)" dù callback đã được bảo vệ.
    pending?.catch?.((error) => {
      if (/extension context invalidated/i.test(String(error?.message || error))) { finished = true; return; }
      finish({ ok: false, error: String(error?.message || error).slice(0, 220) });
    });
  } catch (error) {
    if (/extension context invalidated/i.test(String(error?.message || error))) return;
    document.dispatchEvent(new CustomEvent(eventName, { detail: {
      ok: false, error: String(error?.message || error).slice(0, 220),
    } }));
  }
}

document.addEventListener('discovery-helper-probe', () => {
  runtimeMessage({ type: 'PROBE_DISCOVERY_HELPER' }, 'discovery-helper-probed');
});

document.addEventListener('discovery-helper-connect', (event) => {
  const detail = event.detail ?? {};
  if (!detail.token || !detail.expires_at || !detail.session_id) {
    document.dispatchEvent(new CustomEvent('discovery-helper-connected', { detail: { ok: false, error: 'Pairing data is incomplete.' } }));
    return;
  }
  relayCsrf = detail.csrf ?? relayCsrf;
  runtimeMessage({
    type: 'SET_DISCOVERY_AUTH', token: detail.token,
    expires_at: detail.expires_at, session_id: detail.session_id,
  }, 'discovery-helper-connected');
});

document.addEventListener('discovery-helper-start-job', (event) => {
  runtimeMessage({ type: 'START_DISCOVERY_JOB', job: event.detail?.job }, 'discovery-helper-job-started');
});

document.addEventListener('discovery-helper-stop-job', (event) => {
  runtimeMessage({ type: 'STOP_DISCOVERY_JOB', job_id: event.detail?.job_id }, 'discovery-helper-job-stopped');
});

document.addEventListener('discovery-helper-start-portfolio', (event) => {
  runtimeMessage({ type: 'START_ADVERTISER_COLLECTION', ...(event.detail ?? {}) }, 'discovery-helper-portfolio-started');
});

document.addEventListener('discovery-helper-research-catcher', (event) => {
  runtimeMessage({ type: 'START_CATCHER_RESEARCH', ...(event.detail ?? {}) }, 'discovery-helper-catcher-started');
});

document.addEventListener('discovery-helper-resume-advertisers', (event) => {
  runtimeMessage({ type: 'RESUME_ADVERTISER_DISCOVERY', job_id: event.detail?.job_id }, 'discovery-helper-advertisers-resumed');
});

document.addEventListener('discovery-helper-open-panel', () => {
  runtimeMessage({ type: 'OPEN_HELPER_PANEL' }, 'discovery-helper-panel-opened');
});

// Giữ một bridge có allowlist chặt cho các lệnh Hi Auto chủ động gửi sang Helper.
// Tên event cũ có chữ "coupon" được giữ để tương thích, nhưng nó cũng là đường điều khiển
// SiteData từ màn Sàng lọc. Thiếu TRAFFIC_QUEUE_RUN ở đây khiến lệnh bị chặn trước service worker.
const HELPER_COMMANDS = new Set([
  'COUPON_QUEUE_RUN', 'COUPON_QUEUE_PAUSE', 'COUPON_JOB_PAUSE', 'COUPON_JOB_CANCEL',
  'COUPON_JOB_RESUME', 'COUPON_JOB_DEEPER', 'COUPON_JOB_SKIP', 'COUPON_SYNC_CANDIDATES',
  'TRAFFIC_QUEUE_RUN', 'TRAFFIC_QUEUE_PAUSE', 'TRAFFIC_QUEUE_RESUME',
  'TRAFFIC_JOB_REPASTE', 'TRAFFIC_JOB_SKIP', 'TRAFFIC_ITEM_RETRY', 'TRAFFIC_ITEM_SKIP',
]);
document.addEventListener('discovery-helper-coupon-command', (event) => {
  const detail = event.detail ?? {};
  if (!HELPER_COMMANDS.has(detail.type)) {
    document.dispatchEvent(new CustomEvent('discovery-helper-coupon-commanded', {
      detail: { ok: false, error: 'Lệnh Browser Helper không hợp lệ.' },
    }));
    return;
  }
  runtimeMessage({ ...detail }, 'discovery-helper-coupon-commanded');
});

document.addEventListener('browser-helper-keyword-planner', (event) => {
  const type = event.detail?.type === 'RESUME_KEYWORD_PLANNER_QUEUE'
    ? 'RESUME_KEYWORD_PLANNER_QUEUE' : 'START_KEYWORD_PLANNER';
  runtimeMessage({ type }, 'browser-helper-keyword-planner-result');
});

document.addEventListener('browser-helper-affiliate-application', (event) => {
  runtimeMessage({ type: 'START_AFFILIATE_APPLICATION', ...(event.detail ?? {}) },
    'browser-helper-affiliate-application-result');
});

document.addEventListener('browser-helper-affiliate-search', (event) => {
  runtimeMessage({ type: 'START_AFFILIATE_SEARCH', ...(event.detail ?? {}) },
    'browser-helper-affiliate-search-result');
});

document.addEventListener('browser-helper-domain-verification', (event) => {
  runtimeMessage({ type: 'START_DOMAIN_VERIFICATION', ...(event.detail ?? {}) },
    'browser-helper-domain-verification-result');
});

document.addEventListener('browser-helper-set-context', (event) => {
  runtimeMessage({ type: 'SET_HELPER_CONTEXT', ...(event.detail ?? {}) },
    'browser-helper-context-set');
});

document.addEventListener('browser-helper-affiliate-permission', (event) => {
  runtimeMessage({ type: 'REQUEST_AFFILIATE_PERMISSION', application_url: event.detail?.application_url },
    'browser-helper-affiliate-permission-result');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'REQUEST_HELPER_PAIRING') {
    document.dispatchEvent(new CustomEvent('browser-helper-auto-connect-request'));
    sendResponse({ ok: true }); return false;
  }
  if (message?.type === 'DISCOVERY_DATA_UPDATED') {
    document.dispatchEvent(new CustomEvent('discovery-helper-data-updated', { detail: message }));
    sendResponse({ ok: true }); return false;
  }
  if (message?.type !== 'ADS_DISCOVERY_FETCH') return false;
  const request = message.request ?? {};
  const method = String(request.method ?? 'GET').toUpperCase();
  const path = relayPath(request.path);
  if (!path || !RELAY_ALLOWED_METHODS.has(method)) {
    sendResponse({ ok: false, error: `Relay từ chối đường dẫn ngoài phạm vi Browser Helper: ${String(request.path).slice(0, 120)}` });
    return false;
  }
  const headers = { 'content-type': 'application/json', 'X-Ads-Discovery-Token': request.token ?? '' };
  if (relayCsrf) headers[HI_AUTO_CSRF_HEADER] = relayCsrf;
  fetch(path, {
    method, credentials: 'same-origin', headers,
    body: request.body == null ? undefined : JSON.stringify(request.body),
  }).then(async (response) => {
    const text = await response.text(); let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    sendResponse(response.ok ? { ok: true, data } : {
      ok: false, status: response.status,
      error_code: data?.detail?.code ?? data?.code ?? null,
      error: data?.detail?.message ?? data?.detail ?? text,
    });
  }).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
})();
