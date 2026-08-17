export const PARSER_VERSION = 'discovery-browser/1.5.1';

export const REASON_CODES = Object.freeze({
  NON_PAID_ORGANIC: 'non_paid_organic',
  MISSING_REQUIRED_FIELD: 'missing_required_field',
  DUPLICATE_CAPTURE: 'duplicate_capture',
  DOMAIN_NOT_CATCHER: 'domain_not_catcher',
  DOMAIN_OFFICIAL_MERCHANT: 'domain_official_merchant',
  DOMAIN_AGENCY_OR_UNKNOWN: 'domain_agency_or_unknown',
  USER_REJECTED: 'user_rejected',
  UNKNOWN_LANDING: 'unknown_landing',
  DUPLICATE_CREATIVE: 'duplicate_creative',
  SAFETY_LIMIT: 'safety_limit',
  THREE_EMPTY_BATCHES: 'three_empty_batches',
  REPORTED_TOTAL_REACHED: 'reported_total_reached',
  PARSE_ERROR: 'parse_error',
  NO_PROJECT_SIGNAL: 'no_project_signal',
  STALE_UULE: 'stale_uule',
  UULE_COORDINATE_MISMATCH: 'uule_coordinate_mismatch',
  GEOCODE_TIMEOUT: 'geocode_timeout',
  MISSING_CREATIVE_TEXT: 'missing_creative_text',
  FILTER_CONTEXT_CHANGED: 'filter_context_changed'
});

function decode(text) {
  return String(text ?? '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');
}
function clean(text) { return decode(String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
function attr(text, name) { return decode(String(text ?? '').match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] ?? ''); }
function field(body, name) {
  const tagged = body.match(new RegExp(`<[^>]+data-field=["']${name}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i'));
  if (tagged) return clean(tagged[1]);
  if (name === 'headline') return clean(body.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);
  return '';
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }

export function fingerprintText(value) {
  const input = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp_${hash.toString(16).padStart(8, '0')}`;
}

function findInput(html, names) {
  for (const name of names) {
    for (const attribute of ['id', 'name']) {
      const regex = new RegExp(`<(?:input|select|textarea)\\b[^>]*${attribute}=["']${name}["'][^>]*>`, 'i');
      const tag = html.match(regex)?.[0];
      if (tag) return { selector: attribute === 'id' ? `#${name}` : `[name="${name}"]`, value: attr(tag, 'value') };
    }
  }
  return null;
}

export function buildValentinFillPlan(html, session) {
  const countryOnly = session.location_mode === 'country_only';
  const fields = {
    query: { node: findInput(html, ['search-input', 'query', 'q']), value: session.query },
    regions: { node: findInput(html, ['regions', 'region']), value: session.region_display ?? `${session.country_name ?? session.country_code} - ${session.language_name ?? session.language_code}` },
    language: { node: findInput(html, ['hl', 'language_code', 'language']), value: session.language_code },
    country: { node: findInput(html, ['gl', 'country_code', 'country']), value: session.country_code },
    location: { node: findInput(html, ['place', 'exact_location', 'location', 'address']), value: countryOnly ? '' : session.exact_location }
  };
  const missing = Object.entries(fields).filter(([, item]) => !item.node).map(([name]) => name);
  return {
    ready: missing.length === 0,
    skip_geocode: countryOnly,
    assignments: Object.fromEntries(Object.entries(fields).filter(([, item]) => item.node).map(([name, item]) => [name, { selector: item.node.selector, value: item.value }])),
    geocode_selector: /id=["']button-locate["']/i.test(html) ? '#button-locate' : html.match(/<button\b[^>]*(?:data-action=["']geocode["']|id=["']geocode["'])/i) ? '[data-action="geocode"],#geocode' : null,
    submit_selector: /id=["']button-search["']/i.test(html) ? '#button-search' : '[data-action="submit"],button[type="submit"]',
    coordinate_selectors: { latitude: '#latitude', longitude: '#longitude', uule: '#uule' },
    missing, error: missing.length ? `Valentin DOM changed; missing fields: ${missing.join(', ')}` : null
  };
}

function inputValue(html, ids) {
  const node = findInput(html, ids);
  return node?.value ?? '';
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('utf8');
  return decodeURIComponent([...atob(padded)].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
}

export function decodeUule(value) {
  const observed = String(value ?? '').trim();
  // Valentin may round-trip query-string plus signs as spaces in its hidden input.
  // Spaces are not valid base64, so restoring them is unambiguous for a/w UULEs.
  const uule = /^[aw] /.test(observed) ? observed.replaceAll(' ', '+') : observed;
  const diagnostic = { observed_prefix: observed.slice(0, 16), observed_length: observed.length };
  try {
    if (uule.startsWith('a+')) {
      const payload = decodeBase64Url(uule.slice(2));
      const latitudeE7 = Number(payload.match(/latitude_e7:\s*(-?\d+)/)?.[1]);
      const longitudeE7 = Number(payload.match(/longitude_e7:\s*(-?\d+)/)?.[1]);
      if (!Number.isFinite(latitudeE7) || !Number.isFinite(longitudeE7) || !/role:\s*\d+/.test(payload) || !/producer:\s*\d+/.test(payload)) throw new Error('coordinate payload is incomplete');
      const latitude = latitudeE7 / 1e7, longitude = longitudeE7 / 1e7;
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('coordinates are outside valid ranges');
      return { valid: true, format: 'coordinate', latitude, longitude, payload, normalized_uule: uule };
    }
    if (uule.startsWith('w+')) {
      const bytes = typeof Buffer !== 'undefined' ? Buffer.from(uule.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64') : Uint8Array.from(atob(uule.slice(2)), (char) => char.charCodeAt(0));
      if (bytes.length < 7 || bytes[0] !== 8 || bytes[1] !== 2 || bytes[2] !== 16 || bytes[4] !== 34) throw new Error('canonical payload header is invalid');
      const length = bytes[5]; const canonicalName = new TextDecoder().decode(bytes.slice(6, 6 + length));
      if (!canonicalName || 6 + length > bytes.length) throw new Error('canonical payload is incomplete');
      return { valid: true, format: 'canonical', canonical_name: canonicalName, latitude: null, longitude: null, normalized_uule: uule };
    }
    throw new Error(`unsupported UULE prefix (observed ${JSON.stringify(diagnostic.observed_prefix)}, length ${diagnostic.observed_length})`);
  } catch (error) { return { valid: false, format: null, error: error.message, latitude: null, longitude: null, ...diagnostic }; }
}

export function readValentinControls(html) {
  if (html && typeof html === 'object') return {
    query: String(html.query ?? ''), regions: String(html.regions ?? ''), language_code: String(html.language_code ?? ''), country_code: String(html.country_code ?? ''), exact_location: String(html.exact_location ?? ''),
    latitude: Number(html.latitude), longitude: Number(html.longitude), uule: String(html.uule ?? '')
  };
  return {
    query: inputValue(html, ['search-input', 'query', 'q']), regions: inputValue(html, ['regions', 'region']),
    language_code: inputValue(html, ['hl', 'language_code', 'language']), country_code: inputValue(html, ['gl', 'country_code', 'country']),
    exact_location: inputValue(html, ['place', 'exact_location', 'location', 'address']),
    latitude: Number(inputValue(html, ['latitude'])), longitude: Number(inputValue(html, ['longitude'])), uule: inputValue(html, ['uule', 'generated-uule'])
  };
}

export function parseValentinState(html, options = {}) {
  const controls = readValentinControls(html); const session = options.session ?? {};
  const latitude = controls.latitude, longitude = controls.longitude, uule = controls.uule;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !uule) return { state: 'pending', uule: null, error: 'Waiting for finite coordinates and a non-empty UULE', latitude: null, longitude: null, reason_code: REASON_CODES.MISSING_REQUIRED_FIELD };
  if (session.language_code && controls.language_code.toLowerCase() !== String(session.language_code).toLowerCase()) return { state: 'error', uule: null, error: 'Valentin host language does not match the discovery session', latitude, longitude, reason_code: REASON_CODES.PARSE_ERROR };
  if (session.country_code && controls.country_code.toUpperCase() !== String(session.country_code).toUpperCase()) return { state: 'error', uule: null, error: 'Valentin geo country does not match the discovery session', latitude, longitude, reason_code: REASON_CODES.PARSE_ERROR };
  const decoded = decodeUule(uule);
  if (!decoded.valid) return { state: 'error', uule: null, error: `Invalid UULE payload: ${decoded.error}`, latitude, longitude, reason_code: REASON_CODES.PARSE_ERROR };
  if (decoded.format !== 'coordinate') return { state: 'error', uule: null, error: 'UULE has no coordinates to verify against Valentin controls', latitude, longitude, reason_code: REASON_CODES.UULE_COORDINATE_MISMATCH };
  const tolerance = Number(options.coordinate_tolerance ?? 0.000001);
  if (Math.abs(decoded.latitude - latitude) > tolerance || Math.abs(decoded.longitude - longitude) > tolerance) return { state: 'error', uule: null, error: 'UULE coordinates do not match Valentin latitude/longitude controls', latitude, longitude, decoded, reason_code: REASON_CODES.UULE_COORDINATE_MISMATCH };
  const before = options.before;
  const requestedLocation = String(session.exact_location ?? '').trim();
  const currentLocation = controls.exact_location.trim();
  const beforeLocation = String(before?.exact_location ?? '').trim();
  const exactLocationMatch = !requestedLocation || currentLocation === requestedLocation;
  const canonicalizedAfterExactFill = Boolean(requestedLocation && beforeLocation === requestedLocation && options.completion_signal);
  if (!exactLocationMatch && !canonicalizedAfterExactFill) return { state: 'error', uule: null, error: 'Valentin location no longer matches the discovery session', latitude, longitude, reason_code: REASON_CODES.PARSE_ERROR };
  const normalizedUule = decoded.normalized_uule ?? uule;
  const normalizedBeforeUule = before?.uule ? (decodeUule(before.uule).normalized_uule ?? String(before.uule).trim()) : '';
  const changed = before ? normalizedUule !== normalizedBeforeUule || latitude !== before.latitude || longitude !== before.longitude : true;
  if (before?.uule && !changed && !options.completion_signal) return { state: 'pending', uule: null, error: 'Pre-existing UULE has not been regenerated by the current geocode action', latitude, longitude, reason_code: REASON_CODES.STALE_UULE };
  const evidence = changed ? 'uule_or_coordinates_changed_after_geocode' : 'same_location_completion_signal_with_matching_coordinates';
  return { state: 'valid', uule: normalizedUule, error: null, latitude, longitude, decoded, geocode_evidence: evidence, observed_location: currentLocation, location_evidence: exactLocationMatch ? 'exact_session_text' : 'geocoder_canonicalized_after_exact_fill' };
}

export async function waitForValentinGeocode({ read_state, timeout_ms = 10_000, poll_ms = 100, now_ms = () => Date.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const started = now_ms(); let last;
  while (now_ms() - started < timeout_ms) {
    last = await read_state();
    if (last?.state === 'valid' || last?.state === 'error') return last;
    await delay(poll_ms);
  }
  return { state: 'error', uule: null, latitude: null, longitude: null, reason_code: REASON_CODES.GEOCODE_TIMEOUT, error: `Valentin geocode timed out after ${timeout_ms}ms`, last_state: last ?? null };
}

export function canSubmitValentinState(state) { return state?.state === 'valid' && Boolean(state.uule) && Number.isFinite(state.latitude) && Number.isFinite(state.longitude); }

export function buildGoogleSerpUrl(currentUrl, session, pageNumber) {
  const countryOnly = session.location_mode === 'country_only';
  if (!countryOnly && (session.uule_state !== 'valid' || !session.uule)) throw new Error('A validated UULE from Valentin is required');
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > Number(session.serp_pages ?? 5)) throw new Error('Requested SERP page is outside the active session');
  const url = new URL(currentUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.google.com' || url.pathname !== '/search') throw new Error('Current tab must be https://www.google.com/search');
  url.searchParams.set('q', session.query); url.searchParams.set('gl', session.country_code.toLowerCase());
  url.searchParams.set('hl', session.language_code);
  if (countryOnly) url.searchParams.delete('uule'); else url.searchParams.set('uule', session.uule);
  url.searchParams.set('start', String((pageNumber - 1) * 10));
  return url.toString();
}

export function validateGoogleSerpContext(currentUrl, session, pageNumber = null) {
  const mismatches = []; let url;
  try { url = new URL(currentUrl); } catch { return { valid: false, page_number: null, mismatches: [{ field: 'url', expected: 'Google Search URL', actual: String(currentUrl ?? '') }] }; }
  if (url.protocol !== 'https:' || url.hostname !== 'www.google.com' || url.pathname !== '/search') mismatches.push({ field: 'url', expected: 'https://www.google.com/search', actual: `${url.protocol}//${url.hostname}${url.pathname}` });
  const countryOnly = session.location_mode === 'country_only';
  const expected = { q: String(session.query ?? ''), gl: String(session.country_code ?? '').toLowerCase(), hl: String(session.language_code ?? '') };
  if (!countryOnly) expected.uule = String(session.uule ?? '');
  for (const [field, value] of Object.entries(expected)) {
    const actual = url.searchParams.get(field) ?? '';
    const comparableActual = field === 'gl' ? actual.toLowerCase() : field === 'uule' ? (/^[aw] /.test(actual) ? actual.replaceAll(' ', '+') : actual) : actual;
    const comparableExpected = field === 'uule' && /^[aw] /.test(value) ? value.replaceAll(' ', '+') : value;
    if (comparableActual !== comparableExpected) mismatches.push({ field, expected: value, actual });
  }
  if (countryOnly && (url.searchParams.get('uule') ?? '') !== '') mismatches.push({ field: 'uule', expected: 'absent or empty for country_only', actual: url.searchParams.get('uule') ?? '' });
  const startRaw = url.searchParams.get('start') ?? '0'; const start = Number(startRaw);
  const validStart = /^\d+$/.test(startRaw) && Number.isSafeInteger(start) && start >= 0 && start % 10 === 0;
  if (!validStart) mismatches.push({ field: 'start', expected: 'non-negative multiple of 10', actual: startRaw });
  const inferredPage = validStart ? start / 10 + 1 : null;
  if (pageNumber != null && inferredPage !== Number(pageNumber)) mismatches.push({ field: 'page', expected: Number(pageNumber), actual: inferredPage });
  if (inferredPage != null && (inferredPage < 1 || inferredPage > Number(session.serp_pages ?? 5))) mismatches.push({ field: 'page_limit', expected: `1-${Number(session.serp_pages ?? 5)}`, actual: inferredPage });
  if (!countryOnly && (session.uule_state !== 'valid' || !session.uule)) mismatches.push({ field: 'uule_state', expected: 'valid', actual: session.uule_state ?? 'unknown' });
  return { valid: mismatches.length === 0, page_number: inferredPage, start: validStart ? start : null, mismatches };
}

function safeLandingUrl(href, sourceUrl, explicit) {
  if (explicit) { try { return new URL(explicit, sourceUrl).toString(); } catch { return null; } }
  if (!href) return null;
  try {
    const url = new URL(href, sourceUrl);
    const encoded = url.searchParams.get('adurl') || url.searchParams.get('url');
    if (encoded) { const target = new URL(encoded); if (/^https?:$/.test(target.protocol)) return target.toString(); }
    if (!/(^|\.)google\./i.test(url.hostname) && /^https?:$/.test(url.protocol)) return url.toString();
  } catch { /* Unknown remains unknown; never infer. */ }
  return null;
}

export function parseSerpHtml(html, context) {
  const results = [];
  const pattern = /<(article|section)\b([^>]*data-discovery-result=["'](?:paid|organic)["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) results.push({ attrs: match[2], body: match[3], type: attr(match[2], 'data-discovery-result') });
  const ads = [], dropped = [], seen = new Set();
  for (const result of results) {
    if (result.type !== 'paid') { dropped.push({ reason_code: REASON_CODES.NON_PAID_ORGANIC, evidence: clean(result.body).slice(0, 240) }); continue; }
    const anchor = result.body.match(/<a\b([^>]*)>/i);
    const href = attr(anchor?.[1], 'href');
    const landingUrl = safeLandingUrl(href, context.source_url, attr(result.attrs, 'data-landing-url'));
    const headline = field(result.body, 'headline');
    const description = field(result.body, 'description');
    const displayUrl = field(result.body, 'display-url');
    if (!headline && !displayUrl) { dropped.push({ reason_code: REASON_CODES.MISSING_REQUIRED_FIELD, evidence: clean(result.body).slice(0, 240) }); continue; }
    const displayDomain = (() => { try { return new URL(/^https?:/i.test(displayUrl) ? displayUrl : `https://${displayUrl.split(/[ ›/]/)[0]}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } })();
    const placement = ['top','bottom'].includes(attr(result.attrs, 'data-placement')) ? attr(result.attrs, 'data-placement') : 'unknown';
    const ad = {
      headline, description, display_url: displayUrl || null, display_domain: displayDomain,
      display_path: field(result.body, 'display-path') || null, google_url: href ? new URL(href, context.source_url).toString() : null,
      landing_url: landingUrl, landing_state: landingUrl ? 'observed' : 'unknown', placement,
      query: context.query, country_code: context.country_code, language_code: context.language_code,
      exact_location: context.exact_location, device: context.device, observed_at: context.observed_at,
      source_url: context.source_url, raw_evidence: clean(result.body).slice(0, 1000), parser_version: PARSER_VERSION
    };
    const key = fingerprintText([ad.headline, ad.description, ad.display_url, ad.landing_url, placement].join('|'));
    if (seen.has(key)) dropped.push({ reason_code: REASON_CODES.DUPLICATE_CAPTURE, evidence: ad.raw_evidence });
    else { seen.add(key); ads.push({ ...ad, parser_fingerprint: key }); }
  }
  return { ads, dropped, input_count: results.length, kept_count: ads.length, dropped_count: dropped.length, parser_version: PARSER_VERSION };
}

export function parseSerpDocument(doc, context) {
  const nodes = [...doc.querySelectorAll('[data-discovery-result], [data-text-ad], .uEierd')];
  if (!nodes.length) {
    const recognizableSerp = Boolean(doc.querySelector?.('#search, #rso'));
    if (recognizableSerp) return { ads: [], dropped: [], input_count: 0, kept_count: 0, dropped_count: 0, status: 'complete', parser_version: PARSER_VERSION };
    return { ads: [], dropped: [{ reason_code: REASON_CODES.PARSE_ERROR, evidence: 'No supported paid-result containers or recognizable SERP shell found; Google DOM may have changed' }], input_count: 1, kept_count: 0, dropped_count: 1, status: 'error', parser_version: PARSER_VERSION };
  }
  const records = nodes.map((node) => {
    const syntheticType = node.getAttribute('data-discovery-result');
    const marker = `${node.getAttribute('data-text-ad') ?? ''} ${node.textContent ?? ''}`;
    const paid = syntheticType === 'paid' || node.hasAttribute('data-text-ad') || node.classList?.contains('uEierd') || /\b(?:sponsored|ad|ads|quảng cáo)\b/i.test(marker.slice(0, 180));
    const topContainer = node.closest?.('#tads,[data-placement="top"],.commercial-unit-desktop-top');
    const bottomContainer = node.closest?.('#bottomads,[data-placement="bottom"],.commercial-unit-desktop-bottom');
    const anchor = node.querySelector('a[href]');
    const displayNode = node.querySelector('[data-field="display-url"],cite,.qzEoUe');
    const pathNode = node.querySelector('[data-field="display-path"]');
    return {
      paid, placement: topContainer ? 'top' : bottomContainer ? 'bottom' : 'unknown',
      headline: node.querySelector('[data-field="headline"],h3,[role="heading"]')?.textContent?.trim() ?? '',
      description: node.querySelector('[data-field="description"],.MUxGbd,.yXK7lf')?.textContent?.trim() ?? '',
      display_url: displayNode?.textContent?.trim() ?? '', display_path: pathNode?.textContent?.trim() ?? '',
      href: anchor?.href ?? '', explicit_landing: node.getAttribute('data-landing-url') ?? anchor?.getAttribute('data-landing-url') ?? '',
      evidence: node.innerText?.trim() ?? node.textContent?.trim() ?? ''
    };
  });
  const ads = [], dropped = [], seen = new Set();
  for (const record of records) {
    if (!record.paid) { dropped.push({ reason_code: REASON_CODES.NON_PAID_ORGANIC, evidence: record.evidence.slice(0, 240) }); continue; }
    if (!record.headline && !record.display_url) { dropped.push({ reason_code: REASON_CODES.MISSING_REQUIRED_FIELD, evidence: record.evidence.slice(0, 240) }); continue; }
    const landingUrl = safeLandingUrl(record.href, context.source_url, record.explicit_landing);
    const displayDomain = (() => { try { return new URL(/^https?:/i.test(record.display_url) ? record.display_url : `https://${record.display_url.split(/[ ›/]/)[0]}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } })();
    const ad = { headline: record.headline, description: record.description, display_url: record.display_url || null, display_domain: displayDomain, display_path: record.display_path || null, google_url: record.href || null, landing_url: landingUrl, landing_state: landingUrl ? 'observed' : 'unknown', placement: record.placement, query: context.query, country_code: context.country_code, language_code: context.language_code, exact_location: context.exact_location, device: context.device, observed_at: context.observed_at, source_url: context.source_url, raw_evidence: record.evidence.slice(0, 1000), parser_version: PARSER_VERSION };
    const key = fingerprintText([ad.headline,ad.description,ad.display_url,ad.landing_url,ad.placement].join('|'));
    if (seen.has(key)) dropped.push({ reason_code: REASON_CODES.DUPLICATE_CAPTURE, evidence: ad.raw_evidence }); else { seen.add(key); ads.push({ ...ad, parser_fingerprint: key }); }
  }
  return { ads, dropped, input_count: records.length, kept_count: ads.length, dropped_count: dropped.length, status: 'complete', parser_version: PARSER_VERSION };
}

function parseSeparatedNumber(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

const PROFILE_LABELS = Object.freeze({
  legal_name: ['Legal name', 'Tên pháp lý'], location: ['Based in', 'Trụ sở ở'], payer_name: ['Paid for by', 'Người thanh toán']
});
const ALL_PROFILE_LABELS = Object.values(PROFILE_LABELS).flat();
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelPattern = (labels) => labels.map(escapeRegex).join('|');

function recordLines(record) {
  const lines = Array.isArray(record?.text_lines) ? record.text_lines : String(record?.visible_text ?? '').split(/\r?\n/);
  return lines.map((line) => String(line).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function semanticValue(lines, labels) {
  const targets = labelPattern(labels); const boundaries = labelPattern(ALL_PROFILE_LABELS);
  for (let index = 0; index < lines.length; index++) {
    const exact = lines[index].match(new RegExp(`^\\s*(?:${targets})\\s*[:：-]?\\s*(.*)$`, 'i'));
    if (exact) {
      const inline = exact[1]?.trim();
      if (inline) return inline.replace(new RegExp(`\\s+(?=(?:${boundaries})\\s*[:：-]?).*$`, 'i'), '').trim();
      const next = lines[index + 1]?.trim();
      if (next && !new RegExp(`^(?:${boundaries})\\s*[:：-]?`, 'i').test(next)) return next;
    }
  }
  const joined = lines.join(' ');
  const match = joined.match(new RegExp(`(?:^|\\s)(?:${targets})\\s*[:：-]?\\s*(.+?)(?=\\s+(?:${boundaries})\\s*[:：-]?|\\s+(?:identity\\s+verified|verified|đã\\s+xác\\s+minh)\\b|$)`, 'i'));
  return match?.[1]?.trim() || null;
}

function profileRecordScore(record, role) {
  const lines = recordLines(record); const inline = lines.join(' '); let score = 0;
  if (record.role === role) score += 500;
  if (role === 'advertiser_details' && /advertiser details|thông tin chi tiết/i.test(record.semantic_label ?? '')) score += 400;
  if (role === 'region_filter' && /region|khu vực/i.test(record.semantic_label ?? '')) score += 400;
  score += ALL_PROFILE_LABELS.filter((label) => new RegExp(escapeRegex(label), 'i').test(inline)).length * 80;
  if (lines.length <= 12 && inline.length <= 1200) score += 100;
  if (inline.length > 3000 || record.candidate_quality?.global_text || /(?:document|body|html):?$/i.test(record.scope_path ?? '')) score -= 1000;
  return score + Math.min(Number(record.depth ?? 0), 20);
}

function chooseProfileRecord(records, role) { return [...records].sort((a, b) => profileRecordScore(b, role) - profileRecordScore(a, role))[0] ?? null; }
function conservativeAdvertiserIdentity(records) {
  const generic = /^(?:google(?: ads?)?|ads transparency(?: center)?|trung tâm minh bạch quảng cáo|home|trang chủ|advertiser details|thông tin chi tiết về nhà quảng cáo|ad details|thông tin chi tiết về quảng cáo|frequently asked questions|câu hỏi thường gặp|search|tìm kiếm)$/i;
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const candidates = records.filter((record) => record.role === 'advertiser_identity').map((record) => ({
    value: normalize(record.value ?? recordLines(record)[0]), source: record.identity_source ?? 'advertiser_identity',
    scope_path: record.scope_path ?? null, evidence_url: record.evidence_url ?? null
  })).filter((candidate) => candidate.value.length >= 2 && candidate.value.length <= 160
    && /\p{L}/u.test(candidate.value) && !generic.test(candidate.value)
    && !/^\d[\d.,\s]*\s*(?:ads|quảng cáo)$/i.test(candidate.value));
  const preferred = candidates.some((candidate) => candidate.source === 'exact_profile_link')
    ? candidates.filter((candidate) => candidate.source === 'exact_profile_link') : candidates;
  const distinct = new Map();
  for (const candidate of preferred) distinct.set(candidate.value.toLocaleLowerCase(), candidate);
  return { candidate: distinct.size === 1 ? [...distinct.values()][0] : null, distinct: [...distinct.values()] };
}
function normalizedFrameUrl(value) { try { const url = new URL(value); url.searchParams.sort(); return url.toString(); } catch { return null; } }
function latestFrameSnapshots(frameSnapshots) {
  const latest = new Map();
  for (const frame of frameSnapshots) {
    const identity = frame.document_identity ?? frame.document_id ?? `legacy_frame_${frame.frame_id ?? '?'}_${frame.frame_url ?? ''}`;
    const key = `${frame.frame_id ?? '?'}:${identity}`; const existing = latest.get(key);
    const newer = !existing || Number(frame.sequence ?? 0) > Number(existing.sequence ?? 0) || (Number(frame.sequence ?? 0) === Number(existing.sequence ?? 0) && String(frame.observed_at ?? '') > String(existing.observed_at ?? ''));
    if (newer) latest.set(key, frame);
  }
  return [...latest.values()];
}

function candidateScore(candidate) {
  const quality = candidate.candidate_quality ?? {}; let score = 0;
  if (candidate.exact_frame) score += 1000;
  if (quality.unique_creative_ids === 1 && quality.iframe_count === 1) score += 300;
  score += Number(quality.field_count ?? [candidate.headline, candidate.description, candidate.display_url].filter(Boolean).length) * 40;
  if (candidate.card_text) score += 20;
  if (quality.atomic !== false) score += 10;
  if (quality.global_text || candidate.warnings?.includes('ancestor_or_global_candidate')) score -= 10000;
  return score;
}

export function parseAdsTransparencySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Normalized Ads Transparency snapshot is required');
  const sourceUrl = String(snapshot.profile_url ?? snapshot.source_url ?? '');
  const advertiserId = sourceUrl.match(/\/advertiser\/(AR\d+)/i)?.[1] ?? null;
  const records = Array.isArray(snapshot.records) ? snapshot.records : [];
  const detailRecords = records.filter((record) => /advertiser details|thông tin chi tiết về nhà quảng cáo/i.test(`${record.semantic_label ?? ''} ${record.visible_text ?? ''}`));
  const detailRecord = chooseProfileRecord(detailRecords, 'advertiser_details');
  const detailLines = recordLines(detailRecord);
  const labelledLegalName = semanticValue(detailLines, PROFILE_LABELS.legal_name);
  const identity = conservativeAdvertiserIdentity(records);
  const legalName = labelledLegalName ?? identity.candidate?.value ?? null;
  const legalNameProvenance = labelledLegalName
    ? { source: 'labelled_advertiser_details', scope_path: detailRecord?.scope_path ?? null }
    : identity.candidate ? { source: identity.candidate.source, scope_path: identity.candidate.scope_path, evidence_url: identity.candidate.evidence_url } : null;
  const location = semanticValue(detailLines, PROFILE_LABELS.location);
  const verificationMatch = detailLines.join(' ').match(/\b(identity\s+verified|verified)\b|đã\s+xác\s+minh/i);
  const verifiedLine = verificationMatch?.[0] ?? null;
  const regionCandidates = records.filter((record) => record.role === 'region_filter' || (/region|khu vực/i.test(`${record.semantic_label ?? ''} ${record.visible_text ?? ''}`) && /button|filter|lọc|lựa chọn/i.test(`${record.semantic_label ?? ''} ${record.role ?? ''}`)));
  const regionRecord = chooseProfileRecord(regionCandidates, 'region_filter');
  const totalCandidates = records.filter((record) => record.role === 'reported_total' || recordLines(record).some((line) => /\b[\d][\d.,\s]*\s*(?:ads|quảng cáo)\b/i.test(line))).map((record) => ({ record, score: profileRecordScore(record, 'reported_total'), values: unique(recordLines(record).flatMap((line) => [...line.matchAll(/\b([\d][\d.,\s]*)\s*(?:ads|quảng cáo)\b/gi)].map((match) => parseSeparatedNumber(match[1])))) })).filter((item) => item.values.length);
  totalCandidates.sort((a, b) => b.score - a.score); const bestTotals = totalCandidates.filter((item) => item.score === totalCandidates[0]?.score).flatMap((item) => item.values); const distinctBestTotals = unique(bestTotals);
  const reportedTotal = distinctBestTotals.length === 1 ? distinctBestTotals[0] : null;
  const profileWarnings = [];
  if (!advertiserId) profileWarnings.push('missing_advertiser_id');
  if (!legalName) profileWarnings.push('missing_legal_name_review_required');
  if (!labelledLegalName && identity.distinct.length > 1) profileWarnings.push('ambiguous_advertiser_identity_review_required');
  if (distinctBestTotals.length > 1) profileWarnings.push('ambiguous_reported_total_review_required');
  const profile = {
    advertiser_id: advertiserId, profile_url: sourceUrl, advertiser_profile_url: sourceUrl,
    legal_name: legalName, advertiser_name: legalName, location, advertiser_location: location,
    verification_status: verifiedLine, payer_name: semanticValue(detailLines, PROFILE_LABELS.payer_name),
    region_filter: regionRecord?.value ?? regionRecord?.visible_text ?? null, region_code: regionRecord?.region_code ?? null, region_evidence: regionRecord?.region_evidence ?? null, reported_total: reportedTotal,
    evidence: [detailLines.join(' | '), identity.candidate?.value].filter(Boolean).join(' | ').slice(0, 1600),
    field_provenance: legalNameProvenance ? { legal_name: legalNameProvenance } : {}, warnings: profileWarnings,
    review_required: profileWarnings.length > 0, parser_version: PARSER_VERSION
  };

  const frameSnapshots = latestFrameSnapshots(Array.isArray(snapshot.frame_snapshots) ? snapshot.frame_snapshots : []);
  const candidates = [];
  for (const record of records) {
    if (record.creative_id) candidates.push({ ...record, iframe_urls: record.iframe_urls ?? [], card_text: record.card_text ?? '', warnings: record.warnings ?? [] });
    else for (const anchor of record.anchors ?? []) {
      const id = String(anchor.href ?? '').match(/\/creative\/(CR\d+)/i)?.[1]; if (!id) continue;
      candidates.push({ creative_id: id, creative_url: new URL(anchor.href, sourceUrl).toString(), iframe_urls: (record.iframes ?? []).map((frame) => frame.src).filter(Boolean), card_text: record.creative_text ?? record.visible_text ?? '', headline: record.headline, description: record.description, display_url: record.display_url, display_path: record.display_path, landing_url: record.landing_url, scope_path: record.scope_path, candidate_quality: record.candidate_quality ?? { atomic: true }, warnings: record.warnings ?? [] });
    }
  }
  const iframeCreativeIds = new Map();
  for (const candidate of candidates.filter((item) => !item.candidate_quality?.global_text)) for (const url of candidate.iframe_urls) { const key = normalizedFrameUrl(url); if (!key) continue; const set = iframeCreativeIds.get(key) ?? new Set(); set.add(candidate.creative_id); iframeCreativeIds.set(key, set); }
  for (const candidate of candidates) {
    const candidateUrls = unique(candidate.iframe_urls.map(normalizedFrameUrl));
    const canonicalFrames = frameSnapshots.filter((frame) => candidateUrls.includes(normalizedFrameUrl(frame.frame_url)));
    const oneCardIframe = candidate.iframe_urls.length === 1 && candidateUrls.length === 1;
    const uniqueOwner = oneCardIframe && iframeCreativeIds.get(candidateUrls[0])?.size === 1;
    candidate.exact_frame = uniqueOwner && canonicalFrames.length === 1 ? canonicalFrames[0] : null;
    candidate.mapping_reason = candidate.exact_frame ? (candidate.iframe_urls[0] === candidate.exact_frame.frame_url ? 'raw_exact_unique' : 'canonical_unique') : !oneCardIframe ? 'card_iframe_count_not_one' : !uniqueOwner ? 'canonical_url_shared_by_creatives' : canonicalFrames.length > 1 ? `canonical_competitors_${canonicalFrames.length}` : canonicalFrames.length === 0 ? 'no_canonical_frame' : 'iframe_mapping_unknown';
    candidate.score = candidateScore(candidate);
  }
  const groups = new Map(); for (const candidate of candidates) { const group = groups.get(candidate.creative_id) ?? []; group.push(candidate); groups.set(candidate.creative_id, group); }
  const creatives = []; let duplicateCards = 0, rejectedCandidates = 0;
  for (const [id, group] of groups) {
    const usable = group.filter((candidate) => !candidate.candidate_quality?.global_text && !candidate.warnings.includes('ancestor_or_global_candidate')).sort((a, b) => b.score - a.score);
    rejectedCandidates += group.length - usable.length; if (!usable.length) continue; duplicateCards += Math.max(0, group.length - 1);
    const best = usable[0]; const frame = best.exact_frame; const provenance = { ...(best.field_provenance ?? {}) };
    const merged = { headline: frame?.headline ?? best.headline ?? null, description: frame?.description ?? best.description ?? null, creative_text: frame?.creative_text ?? best.card_text ?? null, display_url: frame?.display_url ?? best.display_url ?? null, display_path: frame?.display_path ?? best.display_path ?? null, landing_url: frame?.landing_url ?? best.landing_url ?? null };
    const imageUrls = unique(usable.flatMap((candidate) => [
      ...(candidate.exact_frame?.image_urls ?? []), ...(candidate.image_urls ?? []),
    ])).slice(0, 8);
    for (const key of Object.keys(merged)) if (frame?.[key]) provenance[key] = `iframe:${frame.frame_url}#${frame.sequence ?? '?'}`; else if (merged[key]) provenance[key] ??= `${best.scope_path ?? 'card'}:outer_card`;
    for (const candidate of usable.slice(1)) for (const key of Object.keys(merged)) {
      const value = candidate.exact_frame?.[key] ?? (key === 'creative_text' ? candidate.card_text : candidate[key]);
      if (!merged[key] && value) { merged[key] = value; provenance[key] = candidate.exact_frame ? `iframe:${candidate.exact_frame.frame_url}#${candidate.exact_frame.sequence ?? '?'}` : `${candidate.scope_path ?? 'card'}:merged_outer_card`; }
    }
    const hasIframe = usable.some((candidate) => candidate.iframe_urls.length); const exact = usable.find((candidate) => candidate.exact_frame);
    const profileOnlyValues = new Set([profile.legal_name, profile.advertiser_id, profile.location, profile.payer_name].map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean));
    const profileOnlyText = Boolean(merged.creative_text && profileOnlyValues.has(String(merged.creative_text).trim().toLowerCase()) && !merged.headline && !merged.description && !merged.display_url && !merged.display_path);
    if (profileOnlyText) { merged.creative_text = null; delete provenance.creative_text; }
    const missingText = !merged.creative_text && !merged.headline && !merged.description;
    creatives.push({
      creative_external_id: id, creative_url: best.creative_url, ...merged, image_urls: imageUrls,
      region: best.region ?? profile.region_filter,
      observed_at: frame?.observed_at ?? snapshot.observed_at ?? null, evidence: `${best.scope_path ?? 'card'} | ${exact ? `iframe:${exact.exact_frame.frame_url}` : hasIframe ? `iframe_mapping_unknown:${best.mapping_reason ?? 'uncertain'}` : 'outer_card'}`.slice(0, 1000),
      field_provenance: provenance, candidate_score: best.score, frame_mapping_state: exact ? 'observed' : hasIframe ? 'unknown' : 'not_applicable',
      quality_status: missingText ? 'partial' : 'complete', quality_reason: missingText ? REASON_CODES.MISSING_CREATIVE_TEXT : null,
      parser_version: PARSER_VERSION, fingerprint: fingerprintText([advertiserId, id].join('|'))
    });
  }
  return { profile, creatives, input_count: candidates.length, duplicate_cards: duplicateCards, rejected_candidates: rejectedCandidates, warnings: [...(snapshot.warnings ?? []), ...profileWarnings] };
}

export async function waitForAdsTransparencyProfile({ take_snapshot, timeout_ms = 10_000, poll_ms = 250, on_attempt = null }) {
  if (typeof take_snapshot !== 'function') throw new Error('take_snapshot is required');
  const started = Date.now(); let attempts = 0; let parsed = null;
  const transientWarnings = new Set(['missing_legal_name_review_required', 'ambiguous_advertiser_identity_review_required', 'ambiguous_reported_total_review_required']);
  while (true) {
    attempts++; parsed = parseAdsTransparencySnapshot(await take_snapshot());
    on_attempt?.({ attempts, profile: parsed.profile });
    if (!parsed.profile.review_required) return { parsed, attempts, reason: 'profile_ready' };
    const warnings = parsed.profile.warnings ?? [];
    if (warnings.some((warning) => !transientWarnings.has(warning))) return { parsed, attempts, reason: 'non_transient_review_required' };
    if (Date.now() - started >= timeout_ms) return { parsed, attempts, reason: 'profile_settle_timeout' };
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, poll_ms)));
  }
}

// Compatibility wrappers for sanitized static fixtures and earlier imports. Live collection uses the DOM adapter.
export function parseAdsTransparencyProfile(html, sourceUrl) {
  const text = decode(String(html ?? '').replace(/<\/(?:p|div|section|h[1-6]|dt|dd|li|button)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  const records = [{ semantic_label: 'Advertiser Details', visible_text: text }];
  const parsed = parseAdsTransparencySnapshot({ profile_url: sourceUrl, records });
  if (!parsed.profile.region_filter) parsed.profile.region_filter = clean(html.match(/<button\b[^>]*aria-label=["'](?:Region filter|Bộ lọc khu vực)["'][^>]*>([\s\S]*?)<\/button>/i)?.[1]) || null;
  return parsed.profile;
}

export function parseAdsTransparencyCreatives(html, sourceUrl) {
  const records = [];
  for (const match of String(html ?? '').matchAll(/<a\b([^>]*href=["'][^"']*\/creative\/CR\d+[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)) records.push({ scope_path: 'sanitized-static-html', visible_text: clean(match[2]), anchors: [{ href: attr(match[1], 'href') }] });
  return parseAdsTransparencySnapshot({ profile_url: sourceUrl, records }).creatives;
}

export function mergeManualCreativeObservations(existing = [], incoming = [], limit = 5000) {
  const merged = new Map();
  const fields = [
    'creative_url', 'creative_text', 'headline', 'description', 'display_url', 'display_path',
    'landing_url', 'first_shown', 'last_shown', 'region', 'evidence', 'observed_at',
    'ocr_text', 'ocr_confidence', 'ocr_status', 'ocr_error', 'ocr_source',
    'ocr_asset_sha256', 'ocr_asset_cache_keys', 'ocr_asset_urls',
  ];
  for (const item of [...existing, ...incoming]) {
    const id = String(item?.creative_external_id || item?.creative_id || item?.id || '');
    if (!/^CR\d+$/.test(id)) continue;
    const previous = merged.get(id);
    if (!previous) {
      if (merged.size >= limit) continue;
      merged.set(id, { ...item, creative_external_id: id });
      continue;
    }
    const next = { ...previous, field_provenance: { ...(previous.field_provenance ?? {}) } };
    next.image_urls = unique([...(previous.image_urls ?? []), ...(item.image_urls ?? [])]).slice(0, 8);
    for (const field of fields) {
      const value = item?.[field];
      if (value != null && value !== '' && (!next[field]
          || (previous.quality_status === 'partial' && item.quality_status === 'complete'))) next[field] = value;
    }
    next.field_provenance = { ...next.field_provenance, ...(item.field_provenance ?? {}) };
    if (previous.quality_status === 'partial' && item.quality_status === 'complete') {
      next.quality_status = 'complete'; next.quality_reason = null;
    }
    const mappingRank = { unknown: 0, not_applicable: 1, observed: 2 };
    if ((mappingRank[item.frame_mapping_state] ?? 0) > (mappingRank[next.frame_mapping_state] ?? 0)) {
      next.frame_mapping_state = item.frame_mapping_state;
    }
    merged.set(id, next);
  }
  return [...merged.values()];
}

export function manualCreativeCollection({ creatives = [], reported_total = null, observations = 1,
  filter_urls = [] } = {}) {
  const items = mergeManualCreativeObservations([], creatives);
  const withText = items.filter((item) => item.quality_status !== 'partial'
    && (item.creative_text || item.headline || item.description)).length;
  const partialCount = items.length - withText;
  const idsComplete = reported_total != null && items.length >= Number(reported_total);
  const textComplete = partialCount === 0;
  return {
    creatives: items, reported_total, collected_count: items.length,
    unique_cards_discovered: items.length, creatives_with_text: withText,
    creatives_missing_text: partialCount, partial_count: partialCount,
    id_completeness: idsComplete, text_completeness: textComplete,
    pages_or_batches: Math.max(1, Number(observations) || 1),
    truncated: false, user_confirmed: true,
    data_quality_incomplete: !idsComplete || !textComplete,
    stop_reason: 'manual_user_confirmed', input_count: items.length,
    duplicate_count: 0, updated_existing_count: 0, improved_count: 0,
    batch_evidence: [{ action: 'manual_dom_observation', wait_reason: 'user_confirmed',
      filter_urls: [...new Set(filter_urls)].slice(0, 50) }],
  };
}

export async function collectCreativeBatches({ load_batch, reported_total = null, advertiser_id = null, max_batches = 20, max_empty_batches = 3 }) {
  const collected = new Map(), batchEvidence = []; let emptyStreak = 0, pagesOrBatches = 0, inputCount = 0, duplicateCount = 0, updatedExistingCount = 0, stopReason = REASON_CODES.SAFETY_LIMIT;
  const provenanceRank = (value) => String(value ?? '').startsWith('iframe:') ? 3 : String(value ?? '').includes('outer_card') ? 2 : value ? 1 : 0;
  const materialMerge = (existing, incoming) => {
    const merged = { ...existing, field_provenance: { ...(existing.field_provenance ?? {}) } }; let improved = false;
    for (const field of ['headline','description','creative_text','display_url','display_path','creative_url','first_shown','last_shown','region']) {
      const oldValue = existing[field]; const newValue = incoming[field]; if (newValue == null || newValue === '') continue;
      const oldRank = provenanceRank(existing.field_provenance?.[field]); const newRank = provenanceRank(incoming.field_provenance?.[field]);
      if (!oldValue || newRank > oldRank) { if (oldValue !== newValue || newRank > oldRank) improved = true; merged[field] = newValue; if (incoming.field_provenance?.[field]) merged.field_provenance[field] = incoming.field_provenance[field]; }
    }
    if (existing.quality_status === 'partial' && incoming.quality_status === 'complete') { merged.quality_status = 'complete'; merged.quality_reason = null; improved = true; }
    const mappingRank = { unknown: 0, not_applicable: 1, observed: 2 };
    if ((mappingRank[incoming.frame_mapping_state] ?? 0) > (mappingRank[existing.frame_mapping_state] ?? 0)) { merged.frame_mapping_state = incoming.frame_mapping_state; merged.evidence = incoming.evidence ?? merged.evidence; improved = true; }
    return { merged, improved };
  };
  for (let index = 0; index < max_batches; index++) {
    const batch = await load_batch(index); pagesOrBatches++;
    const items = Array.isArray(batch) ? batch : Array.isArray(batch?.creatives) ? batch.creatives : parseAdsTransparencyCreatives(String(batch?.html ?? batch ?? ''), batch?.source_url ?? 'https://adstransparency.google.com/');
    const adapterDuplicates = Number(batch?.duplicate_cards ?? 0); duplicateCount += adapterDuplicates;
    batchEvidence.push(batch?.batch_evidence ?? { action: 'fixture_batch', wait_reason: 'not_applicable' });
    inputCount += Number(batch?.input_count ?? (items.length + adapterDuplicates));
    let added = 0, improved = 0, unchanged = 0;
    for (const item of items) {
      const key = item.creative_external_id ? `id:${advertiser_id ?? 'unknown'}:${item.creative_external_id}` : item.fingerprint ?? fingerprintText([item.creative_text, item.landing_url].join('|'));
      if (collected.has(key)) {
        const result = materialMerge(collected.get(key), item);
        if (result.improved) { collected.set(key, result.merged); improved++; updatedExistingCount++; } else { duplicateCount++; unchanged++; }
      } else { collected.set(key, item); added++; }
    }
    batchEvidence[batchEvidence.length - 1] = { ...batchEvidence.at(-1), new_count: added, improved_count: improved, unchanged_count: unchanged };
    emptyStreak = added === 0 && improved === 0 ? emptyStreak + 1 : 0;
    const partialNow = [...collected.values()].filter((item) => item.quality_status === 'partial' || (!item.creative_text && !item.headline && !item.description)).length;
    if (reported_total != null && collected.size >= reported_total && partialNow === 0) { stopReason = REASON_CODES.REPORTED_TOTAL_REACHED; break; }
    if (emptyStreak >= max_empty_batches) { stopReason = REASON_CODES.THREE_EMPTY_BATCHES; break; }
  }
  const creatives = [...collected.values()].map((item) => {
    const missing = !item.creative_text && !item.headline && !item.description;
    return { ...item, quality_status: item.quality_status ?? (missing ? 'partial' : 'complete'), quality_reason: item.quality_reason ?? (missing ? REASON_CODES.MISSING_CREATIVE_TEXT : null) };
  });
  const withText = creatives.filter((item) => item.quality_status !== 'partial').length;
  const partialCount = creatives.length - withText; const idsComplete = reported_total != null && creatives.length >= reported_total; const textComplete = partialCount === 0;
  const truncated = (reported_total != null && !idsComplete) || !textComplete || stopReason === REASON_CODES.SAFETY_LIMIT;
  return { creatives, reported_total, collected_count: creatives.length, unique_cards_discovered: creatives.length, creatives_with_text: withText, creatives_missing_text: partialCount, partial_count: partialCount, id_completeness: idsComplete, text_completeness: textComplete, pages_or_batches: pagesOrBatches, truncated, stop_reason: stopReason, input_count: inputCount, duplicate_count: duplicateCount, updated_existing_count: updatedExistingCount, improved_count: updatedExistingCount, batch_evidence: batchEvidence };
}
