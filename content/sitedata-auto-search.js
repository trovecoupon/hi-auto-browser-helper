(async () => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const domain = clean(globalThis.__HI_AUTO_TRAFFIC_DOMAIN__ || '').toLowerCase();
  const bodyText = clean(document.body?.innerText || '').toLowerCase();
  const result = { status: 'loading', reason: 'waiting_for_search_form', source_url: location.href };

  if (/just a moment|checking your browser|verify you are human|attention required|challenge-platform/.test(bodyText)) {
    return { ...result, status: 'needs_user', reason: 'cloudflare' };
  }
  if (/service unavailable|bad gateway|internal server error|temporarily unavailable|error\s*5\d\d/.test(bodyText)) {
    return { ...result, status: 'needs_user', reason: 'sitedata_server_error' };
  }
  if (/too many requests|error\s*429|rate limit (?:exceeded|reached)|requests? limit exceeded|quota exceeded|daily limit/.test(bodyText)) {
    return { ...result, status: 'quota', reason: 'rate_limited_or_quota' };
  }
  if (!domain) return { ...result, status: 'failed', reason: 'missing_domain' };
  if (/\/(?:[a-z]{2}\/)?traffic\//i.test(location.pathname)) {
    return { ...result, status: 'result_page', reason: 'manual_result_detected' };
  }
  if (globalThis.__HI_AUTO_SITEDATA_SUBMITTED__ === domain) {
    return { ...result, status: 'submitted', reason: 'auto_search_submitted' };
  }

  const visible = (element) => Boolean(element && !element.disabled && element.getClientRects().length
    && getComputedStyle(element).visibility !== 'hidden');
  const inputs = [...document.querySelectorAll([
    'input[placeholder*="Enter a domain" i]',
    'input[placeholder*="domain" i]',
    'input[name*="domain" i]',
    'input[type="search"]',
    'input[data-slot="input"]',
  ].join(','))];
  const input = inputs.find((element) => visible(element)
      && /enter a domain|domain|website/i.test(clean(element.placeholder || element.getAttribute('aria-label'))))
    || inputs.find(visible);
  if (!input) return document.readyState === 'complete'
    ? { ...result, status: 'needs_user', reason: 'search_input_missing' }
    : result;

  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  input.focus({ preventScroll: true });
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, domain);
  else input.value = domain;
  input.dispatchEvent(new InputEvent('input', {
    bubbles: true, composed: true, inputType: 'insertText', data: domain,
  }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  // Give SiteData's controlled form time to accept the input before one real click.
  await new Promise((resolve) => setTimeout(resolve, 850));
  const controls = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')];
  const search = controls.find((element) => visible(element)
    && /^(?:search|analyze|check)(?:\s|$)/i.test(clean(
      element.innerText || element.value || element.getAttribute('aria-label'),
    )));
  if (!search) return { ...result, status: 'needs_user', reason: 'search_button_missing' };

  globalThis.__HI_AUTO_SITEDATA_SUBMITTED__ = domain;
  search.scrollIntoView({ behavior: 'smooth', block: 'center' });
  search.focus({ preventScroll: true });
  search.click();
  return { ...result, status: 'submitted', reason: 'auto_search_submitted' };
})();
