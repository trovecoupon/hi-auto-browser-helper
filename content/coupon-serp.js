/**
 * Adapter Google Search cho Coupon Discovery.
 *
 * Chỉ chạy khi service worker ĐANG có lệnh coupon-discovery cho tab này — không có lệnh thì im lặng
 * thoát, không đụng gì vào trang. Không tự bấm nút, không tự sang trang, không vượt CAPTCHA.
 */
(async () => {
  await import(chrome.runtime.getURL('content/shared.js'));
  const parsers = await import(chrome.runtime.getURL('lib/coupon-parsers.mjs'));
  const ui = globalThis.DiscoveryHelperUi;

  let command = null;
  try {
    const response = await ui.message({ type: 'GET_COUPON_COMMAND' });
    command = response?.command ?? null;
  } catch {
    return;                       // Chưa ghép nối hoặc helper đang tắt — không phải lỗi của trang này.
  }
  if (!command || command.kind !== 'search') return;

  const root = await ui.mount('Hi Auto · Tìm coupon');
  ui.status(root, `Đang đọc kết quả cho: ${command.query}`);

  const waitForDom = () => new Promise((resolve) => {
    const finish = () => setTimeout(resolve, 400);
    if (document.readyState === 'complete') finish();
    else addEventListener('load', finish, { once: true });
  });

  try {
    await waitForDom();
    // Google có thể báo `load` khi DOM kết quả/challenge vẫn đang được dựng. Nếu trang còn mơ hồ,
    // quan sát thêm vài giây; thấy CAPTCHA là khóa job ngay thay vì gửi `0 kết quả` rồi chuyển URL.
    const deadline = Date.now() + 6_000;
    let html = '';
    let challenge = null;
    let parsed = null;
    do {
      html = document.documentElement.outerHTML.slice(0, 3_000_000);
      challenge = parsers.detectChallenge({
        url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 4000) ?? '',
      }) ?? parsers.detectChallenge({ html });
      if (challenge) break;
      parsed = parsers.parseGoogleResults(html, { limit: 10 });
      if (parsed.recognized || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 650));
    } while (Date.now() < deadline);

    // CAPTCHA/chặn: BÁO rồi dừng. Tuyệt đối không thử vượt.
    if (challenge) {
      ui.status(root, challenge === 'captcha'
        ? 'Google đang hỏi CAPTCHA. Hãy tự giải trên tab này rồi bấm Tiếp tục ở Side Panel.'
        : 'Google đang chặn truy vấn tự động. Job chuyển sang chờ người xử lý.', true);
      await ui.message({
        type: 'COUPON_SERP_RESULT',
        payload: { job_id: command.job_id, query: command.query, challenge, results: [], snippet_blocks: [] },
      });
      return;
    }

    parsed ??= parsers.parseGoogleResults(html, { limit: 10 });
    const snippetBlocks = [];
    for (const result of parsed.results) {
      for (const block of parsers.codesFromSnippet(result.snippet)) {
        snippetBlocks.push({ ...block, source_result_url: result.url });
      }
    }

    ui.status(root, `Google trả ${parsed.results.length} website kết quả — chưa phải coupon · phát hiện ${snippetBlocks.length} mã trong mô tả.`);
    await ui.message({
      type: 'COUPON_SERP_RESULT',
      payload: {
        job_id: command.job_id, query: command.query, challenge: null,
        recognized: parsed.recognized, results: parsed.results, snippet_blocks: snippetBlocks,
        snippet_source_url: location.href.split('#')[0],
      },
    });
  } catch (error) {
    ui.status(root, `Không đọc được trang kết quả: ${error.message}`, true);
    try {
      await ui.message({
        type: 'COUPON_SERP_RESULT',
        payload: { job_id: command.job_id, query: command.query, error_code: 'PAGE_CHANGED', error_message: error.message, results: [], snippet_blocks: [] },
      });
    } catch { /* Service worker đã ngủ; job sẽ hết lease và được nhận lại. */ }
  }
})();
