/**
 * Adapter chung cho trang nguồn coupon (đối thủ / site brand).
 *
 * KHÔNG khai trong manifest — được tiêm bằng `chrome.scripting.executeScript` SAU KHI người dùng cấp
 * quyền cho đúng origin đó. Nhờ vậy extension không cần quyền match-all mọi scheme, mọi host.
 *
 * Giới hạn an toàn cứng:
 * - Chỉ bấm nút có nhãn "hiện mã/reveal/copy code"; tối đa MAX_REVEAL_CLICKS lần.
 * - TUYỆT ĐỐI không bấm nút thanh toán/đặt hàng/đăng ký/gửi form.
 * - Không điền form, không đọc mật khẩu/OTP, không tự giải CAPTCHA.
 */
(async () => {
  const parsers = await import(chrome.runtime.getURL('lib/coupon-parsers.mjs'));

  const MAX_REVEAL_CLICKS = 6;
  const REVEAL_TEXT = /\b(show|reveal|get|view|see|unlock|copy)\s+(?:the\s+)?(?:coupon\s+)?code\b|\bhiện mã\b|\blấy mã\b/i;
  /** Bấm nhầm những nút này là hành động không đảo ngược được — chặn cứng. */
  const FORBIDDEN_TEXT = /\b(buy|order|checkout|pay|purchase|subscribe|sign\s?up|register|add to (?:cart|bag)|place order|donate|confirm)\b|\bthanh toán\b|\bđặt hàng\b|\bđăng ký\b/i;

  const snapshotNow = () => parsers.couponSnapshotFromHtml(
    document.documentElement.outerHTML.slice(0, 3_000_000), location.href.split('#')[0]);

  const clickable = () => [...document.querySelectorAll('button, a[role="button"], [data-clipboard-text], [onclick]')]
    .filter((node) => {
      const label = (node.innerText || node.textContent || '').trim();
      if (!label || label.length > 60) return false;
      if (FORBIDDEN_TEXT.test(label)) return false;
      if (node.closest('form') && node.type === 'submit') return false;   // không bao giờ gửi form
      return REVEAL_TEXT.test(label);
    });

  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    const first = snapshotNow();
    if (first.challenge || first.login_wall) {
      return { ok: true, snapshot: first, revealed: 0, reason: first.challenge ?? 'login_wall' };
    }

    // Bấm nút hiện mã để lộ phần bị che. Mỗi lần bấm đọc lại DOM — mã mới xuất hiện sẽ được gộp.
    const buttons = clickable().slice(0, MAX_REVEAL_CLICKS);
    let revealed = 0;
    const merged = new Map(first.blocks.map((block) => [String(block.code).toUpperCase(), block]));
    for (const button of buttons) {
      const openedBefore = document.querySelectorAll('[role="dialog"], .modal').length;
      try { button.click(); } catch { continue; }
      revealed += 1;
      await settle(700);
      // Mã có thể nằm trong modal vừa mở, hoặc thay chỗ mã bị che tại chỗ.
      for (const block of snapshotNow().blocks) {
        const key = String(block.code).toUpperCase();
        if (!merged.has(key)) merged.set(key, { ...block, evidence_note: 'after_reveal_click' });
      }
      const clipboard = button.getAttribute?.('data-clipboard-text');
      if (clipboard && clipboard.length <= 40) {
        const key = clipboard.toUpperCase();
        if (!merged.has(key)) {
          merged.set(key, {
            code: clipboard, method: 'clipboard', label: (button.innerText || '').trim(),
            context_text: (button.closest('[class*="coupon" i], [class*="voucher" i], [class*="offer" i]')?.innerText ?? '').slice(0, 400),
            in_coupon_component: true, offer_text: null, expiry: null,
          });
        }
      }
      const openedAfter = document.querySelectorAll('[role="dialog"], .modal').length;
      if (openedAfter > openedBefore) {
        // Đóng modal để nút kế tiếp bấm được; không điều hướng đi đâu cả.
        document.querySelector('[role="dialog"] [aria-label*="close" i], .modal [class*="close" i]')?.click?.();
        await settle(200);
      }
    }

    const final = snapshotNow();
    return { ok: true, revealed, snapshot: { ...final, blocks: [...merged.values()] } };
  } catch (error) {
    return { ok: false, error_code: 'PAGE_CHANGED', error_message: String(error?.message ?? error).slice(0, 200) };
  }
})();
