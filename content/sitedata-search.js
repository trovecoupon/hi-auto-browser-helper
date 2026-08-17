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
  if (/too many requests|rate limit|rate limited|error\s*429|try again later|daily limit|quota exceeded|upgrade your plan|payment required/.test(bodyText)) {
    return { ...result, status: 'quota', reason: 'rate_limited_or_quota' };
  }
  if (!domain) return { ...result, status: 'failed', reason: 'missing_domain' };
  if (/\/(?:[a-z]{2}\/)?traffic\//i.test(location.pathname)) {
    return { ...result, status: 'needs_user', reason: 'already_on_result' };
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
  globalThis.__HI_AUTO_TRAFFIC_FILLED_DOMAIN__ = domain;
  return { ...result, status: 'filled', reason: 'domain_filled_waiting_for_search' };
})()
