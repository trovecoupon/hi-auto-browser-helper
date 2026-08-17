(() => {
  const clean = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const text = clean(document.body?.innerText || '');
  const lower = text.toLowerCase();
  const requestedDomain = clean(globalThis.__HI_AUTO_TRAFFIC_DOMAIN__ || '');
  const parseMetric = (raw) => {
    const normalized = String(raw || '').replace(/,/g, '').trim().toUpperCase();
    const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMB])?$/);
    if (!match) return null;
    const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[match[2]] || 1;
    return Math.round(Number(match[1]) * multiplier);
  };
  const result = { status: 'loading', reason: 'waiting_for_traffic_data', monthly_visits: null, month: null, source_url: location.href };
  if (/just a moment|checking your browser|verify you are human|checking your connection|attention required|challenge-platform/.test(lower)) {
    return { ...result, status: 'needs_user', reason: 'cloudflare' };
  }
  if (requestedDomain && !location.pathname.toLowerCase().includes(requestedDomain.toLowerCase())
      && !lower.includes(requestedDomain.toLowerCase())) {
    return { ...result, status: 'loading', reason: 'waiting_for_domain' };
  }
  if (!/\/(?:[a-z]{2}\/)?traffic\//i.test(location.pathname)) {
    return { ...result, status: 'loading', reason: 'waiting_for_result_page' };
  }
  // This card is the first complete result SiteData renders and is exactly the metric Hi Auto needs.
  // Read it immediately instead of waiting for the heavier Visits Over Time chart below the fold.
  const monthlyCard = text.match(/\bMonthly Visits\b\s*([0-9][0-9.,]*\s*[KMB]?)/i);
  const monthlyVisits = parseMetric(monthlyCard?.[1]);
  if (Number.isFinite(monthlyVisits) && monthlyVisits >= 0) {
    return { ...result, status: 'ok', monthly_visits: monthlyVisits, month: 'latest' };
  }
  const start = lower.indexOf('visits over time');
  const end = start >= 0 ? lower.indexOf('traffic sources', start + 1) : -1;
  const segment = start >= 0 ? text.slice(start, end > start ? end : Math.min(text.length, start + 6000)) : '';
  const rows = [];
  const pattern = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \t]+(20\d{2})[ \t]*\n?[ \t]*([0-9][0-9.,]*[ \t]*[KMB]?)/gi;
  for (const match of segment.matchAll(pattern)) {
    const visits = parseMetric(match[3]);
    if (Number.isFinite(visits)) rows.push({ month: `${match[1]} ${match[2]}`, visits });
  }
  const latest = [...rows].reverse().find((row) => row.visits > 0);
  if (latest) return { ...result, status: 'ok', monthly_visits: latest.visits, month: latest.month };
  // Error/quota phrases can appear in SiteData banners even after the result has loaded.
  // A real Monthly Visits card or chart above always wins; classify errors only when no
  // usable traffic metric exists on the requested domain page.
  if (/no data available|not enough data/i.test(lower)) {
    return { ...result, status: 'no_data', reason: 'no_traffic_data' };
  }
  if (/daily limit|quota exceeded|upgrade your plan|payment required|sign in to continue|log in to continue/.test(lower)) {
    return { ...result, status: 'quota', reason: 'quota_or_login' };
  }
  if (/service unavailable|bad gateway|internal server error|temporarily unavailable|error\s*5\d\d/.test(lower)) {
    return { ...result, status: 'needs_user', reason: 'sitedata_server_error' };
  }
  if (/too many requests|error\s*429|rate limit (?:exceeded|reached)|requests? limit exceeded|you have exceeded (?:your )?(?:daily )?(?:limit|quota)/.test(lower)) {
    return { ...result, status: 'quota', reason: 'rate_limited' };
  }
  if (rows.length && rows.every((row) => row.visits === 0)) {
    return { ...result, status: 'ok', monthly_visits: 0, month: rows.at(-1).month };
  }
  return result;
})();
