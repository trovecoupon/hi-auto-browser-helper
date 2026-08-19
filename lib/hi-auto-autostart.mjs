// Tự bật Side Panel cho tab Hi Auto và kiểm tra bản cập nhật trên GitHub Releases.
//
// GIỚI HẠN CỦA CHROME - đọc trước khi sửa:
// chrome.sidePanel.open() BẮT BUỘC nằm trong một cử chỉ người dùng. Không có cách
// nào mở panel ngay lúc trang vừa tải. Gần nhất có thể là bám vào cú chạm/phím đầu
// tiên trên trang Hi Auto, và cú chạm đó truyền được cử chỉ qua runtime.sendMessage.
// Vì vậy panel mở ở tương tác đầu tiên chứ không phải lúc load. Đó là trần của nền tảng.

export const UPDATE_ALARM = 'hi-auto-update-check';
export const UPDATE_CHECK_MINUTES = 360; // 6 giờ. GitHub cho 60 request/giờ theo IP.
export const GITHUB_LATEST_URL =
  'https://api.github.com/repos/trovecoupon/hi-auto-browser-helper/releases/latest';
export const RELEASE_DOWNLOAD_URL =
  'https://github.com/trovecoupon/hi-auto-browser-helper/releases/latest/download/hi-auto-browser-helper.zip';

const PANEL_PATH = 'sidepanel/panel.html';

/** Bật panel cho đúng tab Hi Auto. Không bao giờ tắt cho tab khác vì
 *  luồng Coupon Harvester cũng mở panel trên tab ngoài. */
export async function enablePanelForTab(tabId) {
  if (!Number.isInteger(Number(tabId))) return false;
  try {
    await chrome.sidePanel?.setOptions?.({
      tabId: Number(tabId), path: PANEL_PATH, enabled: true,
    });
    return true;
  } catch { return false; }
}

export function parseVersion(value) {
  return String(value ?? '').replace(/^v/i, '').split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** So sánh theo từng số, không so sánh chuỗi. '3.10.0' phải lớn hơn '3.9.0'. */
export function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Hỏi GitHub bản mới nhất. Không gửi token: 60 request/giờ theo IP là quá đủ
 *  cho nhịp 6 giờ, mà cũng không phải nhúng secret vào extension. */
export async function checkForUpdate(currentVersion, fetchFn = fetch) {
  let response;
  try {
    response = await fetchFn(GITHUB_LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'network', current: currentVersion };
  }
  if (response.status === 403 || response.status === 429) {
    return { ok: false, error: 'rate_limited', current: currentVersion };
  }
  if (response.status === 404) {
    return { ok: false, error: 'no_release', current: currentVersion };
  }
  if (!response.ok) {
    return { ok: false, error: `http_${response.status}`, current: currentVersion };
  }
  let payload;
  try { payload = await response.json(); } catch {
    return { ok: false, error: 'bad_json', current: currentVersion };
  }
  const latest = String(payload?.tag_name ?? '').replace(/^v/i, '');
  if (!latest) return { ok: false, error: 'no_tag', current: currentVersion };
  const asset = Array.isArray(payload?.assets)
    ? payload.assets.find((item) => String(item?.name ?? '').endsWith('.zip'))
    : null;
  return {
    ok: true,
    current: currentVersion,
    latest,
    hasUpdate: isNewerVersion(latest, currentVersion),
    download_url: asset?.browser_download_url || RELEASE_DOWNLOAD_URL,
    notes: String(payload?.body ?? '').slice(0, 500),
    published_at: payload?.published_at ?? null,
  };
}
