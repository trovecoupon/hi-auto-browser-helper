const LOGIN_WORDS = /(?:sign in|đăng nhập|choose an account|chọn tài khoản)/i;
const RESULT_WORDS = /(?:get results|submit|continue|tiếp tục|xem kết quả|bắt đầu)/i;
const DOWNLOAD_WORDS = /(?:download|tải xuống|tải về)/i;
const FORECAST_ENTRY_WORDS = /(?:get search volume and forecasts|nhận (?:thông tin )?dự đoán và lượng tìm kiếm|nhận số liệu và dự báo)/i;

export function shouldReusePlannerTab(url, resumeHeld = false) {
  if (!resumeHeld) return false;
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:' && parsed.hostname === 'ads.google.com';
  } catch {
    return false;
  }
}

export function base64Bytes(value) {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function visible(element) {
  if (!element || element.disabled) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}

/** Tìm xuyên mọi open shadow root — Google Ads bọc input file trong Material component. */
export function deepQueryAll(root, selector) {
  const found = [];
  const visited = new Set();
  const visit = (scope) => {
    if (!scope || visited.has(scope) || typeof scope.querySelectorAll !== 'function') return;
    visited.add(scope);
    try { found.push(...scope.querySelectorAll(selector)); } catch { return; }
    let elements = [];
    try { elements = scope.querySelectorAll('*'); } catch { /* malformed/test root */ }
    for (const element of elements) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(root);
  return [...new Set(found)];
}

export function pageState(root = document) {
  const text = String(root.body?.innerText || '').slice(0, 12000);
  if (LOGIN_WORDS.test(text) && !root.querySelector('input[type="file"]')) return 'needs_login';
  if (/captcha|unusual traffic|verify (?:that )?you are human/i.test(text)) return 'needs_user';
  if (root.querySelector('input[type="file"]')) return 'upload_ready';
  return 'unknown';
}

export function findFileInput(root = document) {
  const inputs = deepQueryAll(root, 'input[type="file"]');
  return inputs.find(visible) || inputs[0] || null;
}

export function isForecastEntryLabel(value) {
  return FORECAST_ENTRY_WORDS.test(String(value || '').replace(/\s+/g, ' ').trim());
}

/** Ô bên phải trên trang chủ Keyword Planner: “Nhận thông tin dự đoán và lượng tìm kiếm”. */
export function findForecastEntry(root = document) {
  const candidates = deepQueryAll(root, 'a,button,[role="button"],[jsaction]')
    .filter((element) => visible(element)
      && isForecastEntryLabel(element.innerText || element.textContent || element.getAttribute('aria-label')));
  // Google thường lồng nhiều phần tử có jsaction. Chọn phần tử có text ngắn nhất để tránh click cả container.
  return candidates.sort((a, b) => String(a.innerText || a.textContent || '').length
    - String(b.innerText || b.textContent || '').length)[0] || null;
}

export function findAction(root = document, kind = 'result') {
  const pattern = kind === 'download' ? DOWNLOAD_WORDS : RESULT_WORDS;
  return deepQueryAll(root, 'button,[role="button"],a')
    .find((element) => visible(element) && pattern.test(element.innerText || element.getAttribute('aria-label') || ''));
}

export function findCsvDownload(root = document) {
  return deepQueryAll(root, '[role="menuitem"],button,a,[role="option"]')
    .find((element) => visible(element) && /(?:csv|\.csv)/i.test(element.innerText || element.getAttribute('aria-label') || ''));
}

export function assignCsv(input, { name, base64, mime = 'text/csv' }) {
  if (!input || !base64) throw new Error('CSV input is incomplete.');
  const file = new File([base64Bytes(base64)], name || 'keywords.csv', { type: mime });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.files?.length === 1;
}
