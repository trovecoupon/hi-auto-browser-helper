/** Đọc thụ động tab phụ do nút reveal mở. Không click, không điền và không gửi bất kỳ form nào. */
(async () => {
  try {
    const parsers = await import(chrome.runtime.getURL('lib/coupon-parsers.mjs'));
    return {
      ok: true,
      manual_reveal_available: [...document.querySelectorAll('button, a, [role="button"]')].some((node) => {
        const label = String(node.innerText || node.textContent || '').trim();
        return /\b(show|reveal|get|view|see|unlock|copy)\s+(?:the\s+)?(?:coupon\s+)?code\b|\bhiện mã\b|\blấy mã\b/i.test(label)
          && !node.closest('form[action*="checkout" i], form[action*="login" i]');
      }),
      snapshot: parsers.couponSnapshotFromHtml(
        document.documentElement.outerHTML.slice(0, 3_000_000), location.href.split('#')[0],
      ),
    };
  } catch (error) {
    return { ok: false, error_code: 'PAGE_CHANGED', error_message: String(error?.message ?? error).slice(0, 200) };
  }
})();
