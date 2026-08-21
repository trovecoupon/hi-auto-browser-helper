(async () => {
  // CÁCH 2 trong sitedataauto.js (Cường verify 21/08/2026, phiên đã login):
  // form React không có <form>, KHÔNG check isTrusted — muốn ăn phải: native setter
  // + event 'input' bubbles, đợi React render, kiểm __reactProps đã nhận value,
  // rồi click nút (Search/Analyze) nếu enabled, không thì keydown Enter.
  // Dùng làm DỰ PHÒNG khi CÁCH 1 (mở thẳng /traffic/<domain>) không ra số.
  const domain = String(globalThis.__HI_AUTO_TRAFFIC_DOMAIN__ || '').trim().toLowerCase();
  const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const result = { status: 'loading', reason: 'waiting_for_search_form', source_url: location.href };

  if (/just a moment|checking your browser|verify you are human|attention required|challenge-platform/.test(bodyText)) {
    return { ...result, status: 'needs_user', reason: 'cloudflare' };
  }
  if (/service unavailable|bad gateway|internal server error|temporarily unavailable|error\s*5\d\d/.test(bodyText)) {
    return { ...result, status: 'needs_user', reason: 'sitedata_server_error' };
  }
  // "Rate limit exceeded" là marker server-side theo TÀI KHOẢN (file Cường) — không phải theo IP.
  if (/rate limit exceeded|too many requests|error\s*429|quota exceeded|daily limit|upgrade your plan|payment required/.test(bodyText)) {
    return { ...result, status: 'quota', reason: 'rate_limited_or_quota' };
  }
  if (!domain) return { ...result, status: 'failed', reason: 'missing_domain' };
  if (globalThis.__HI_AUTO_SITEDATA_UI_SUBMITTED__ === domain) {
    return { ...result, status: 'submitted', reason: 'ui_search_submitted' };
  }

  const input = document.querySelector('input[placeholder^="Enter a domain"]')
    || document.querySelector('input[placeholder*="domain" i]');
  if (!input) {
    return document.readyState === 'complete'
      ? { ...result, status: 'failed', reason: 'search_input_missing' }
      : result;
  }

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(input, domain);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));

  const reactKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
  if (reactKey && input[reactKey]?.value !== domain) {
    return { ...result, status: 'failed', reason: 'react_state_not_set' };
  }

  const button = [...document.querySelectorAll('button')]
    .find((candidate) => /^(Search|Analyze|Loading)/.test(String(candidate.textContent || '').trim()));
  globalThis.__HI_AUTO_SITEDATA_UI_SUBMITTED__ = domain;
  if (button && /^Loading/.test(String(button.textContent || '').trim())) {
    return { ...result, status: 'submitted', reason: 'ui_search_submitted' };
  }
  if (button && !button.disabled) button.click();
  else {
    // Nút disabled khi state == domain đang hiển thị (trang kết quả cùng domain) → Enter.
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true,
    }));
  }
  return { ...result, status: 'submitted', reason: 'ui_search_submitted' };
})();
