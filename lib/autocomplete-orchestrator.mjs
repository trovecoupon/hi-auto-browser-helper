const MULTIPART_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
  'com.br', 'com.mx', 'com.sg', 'com.tr', 'co.jp', 'co.kr', 'co.in',
]);

const POPUP_SELECTORS = [
  '[role="listbox"]', '[role="menu"]', '[class*="autocomplete" i]',
  '[class*="suggestion" i]', '[class*="typeahead" i]', '[class*="dropdown" i]',
];

const ITEM_SELECTOR = '[role="option"], [role="listitem"], a[href], button, li';

export function normalizeSuggestionHostname(value = '') {
  let text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/[\u200b-\u200d\ufeff]/g, '');
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return parsed.hostname.replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

export function registrableSuggestionDomain(value = '') {
  const hostname = normalizeSuggestionHostname(value);
  if (!hostname) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname === 'localhost') return hostname;
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length <= 2) return hostname;
  const suffix = labels.slice(-2).join('.');
  return MULTIPART_PUBLIC_SUFFIXES.has(suffix)
    ? labels.slice(-3).join('.')
    : labels.slice(-2).join('.');
}

function domainsInText(value = '') {
  const output = new Set();
  const text = String(value || '');
  for (const match of text.matchAll(/(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,63})(?::\d+)?(?:[/?#][^\s]*)?/gi)) {
    const domain = registrableSuggestionDomain(match[1]);
    if (domain) output.add(domain);
  }
  return [...output];
}

export function suggestionCandidateRecord(element) {
  const linked = element?.matches?.('a[href]') ? element : element?.querySelector?.('a[href]');
  const values = [
    linked?.href, element?.href, element?.dataset?.url, element?.dataset?.href,
    element?.getAttribute?.('aria-label'), element?.getAttribute?.('title'),
    element?.innerText, element?.textContent,
  ].filter(Boolean);
  const domains = [...new Set(values.flatMap(domainsInText))];
  return {
    element,
    text: String(element?.innerText || element?.textContent || '').trim().slice(0, 1000),
    href: String(linked?.href || element?.href || element?.dataset?.url || element?.dataset?.href || ''),
    domains,
  };
}

function crossesDiscoveryHelper(element) {
  let node = element;
  while (node) {
    if (node.id === 'discovery-helper') return true;
    node = node.parentNode || node.getRootNode?.()?.host || null;
  }
  return false;
}

export function visibleSuggestionElement(element) {
  if (!element || element.isConnected === false || crossesDiscoveryHelper(element)) return false;
  if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
  const rects = element.getClientRects?.();
  if (rects && rects.length === 0) return false;
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
}

function openDomScopes(root) {
  const scopes = []; const queue = [root]; const seen = new Set();
  while (queue.length) {
    const scope = queue.shift();
    if (!scope || seen.has(scope)) continue;
    seen.add(scope); scopes.push(scope);
    for (const node of scope.querySelectorAll?.('*') || []) {
      if (node.shadowRoot?.mode === 'open' || node.shadowRoot) queue.push(node.shadowRoot);
    }
  }
  return scopes;
}

export function discoverSuggestionCandidates(root = document) {
  const elements = new Set();
  for (const scope of openDomScopes(root)) {
    for (const option of scope.querySelectorAll?.('[role="option"]') || []) elements.add(option);
    for (const selector of POPUP_SELECTORS) {
      for (const popup of scope.querySelectorAll?.(selector) || []) {
        if (!visibleSuggestionElement(popup)) continue;
        const semanticItems = [...(popup.querySelectorAll?.(ITEM_SELECTOR) || [])];
        if (semanticItems.length) {
          for (const item of semanticItems) elements.add(item);
        } else {
          for (const child of popup.children || []) elements.add(child);
        }
      }
    }
  }
  const records = [];
  for (const element of elements) {
    if (!visibleSuggestionElement(element)) continue;
    const semanticAncestor = [...elements].find((candidate) => candidate !== element
      && candidate.contains?.(element)
      && candidate.matches?.('[role="option"], [role="listitem"], li'));
    if (semanticAncestor) continue;
    const record = suggestionCandidateRecord(element);
    if (record.text || record.href || record.domains.length) records.push(record);
  }
  return records;
}

export function exactSuggestionDecision(records = [], catcherDomain = '') {
  const target = registrableSuggestionDomain(catcherDomain);
  const candidates = records.filter((record) => !record.inside_helper).map((record) => ({
    ...record,
    domains: [...new Set(record.domains || domainsInText(`${record.href || ''} ${record.text || ''}`))],
  }));
  const exact = target ? candidates.filter((record) => record.domains.includes(target)) : [];
  const evidence = candidates.map((record) => ({ text: record.text, href: record.href, domains: record.domains }));
  if (exact.length === 1) return { status: 'unique', target, candidate: exact[0], candidates: evidence };
  if (exact.length > 1) return { status: 'ambiguous', target, candidate: null, candidates: evidence };
  return { status: 'missing', target, candidate: null, candidates: evidence };
}

export function fillSearchInput(element, value) {
  const view = element?.ownerDocument?.defaultView || globalThis;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement?.prototype || {}, 'value')?.set;
  if (!setter) throw new Error('Ads Transparency search setter is unavailable.');
  setter.call(element, value);
  element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
}

export function shouldRescanDetachedSuggestion({ detached = false, rescanUsed = false } = {}) {
  return Boolean(detached && !rescanUsed);
}

export function canUseSuggestionKeyboardFallback(decision, stateChanged = false) {
  return !stateChanged && decision?.status === 'unique';
}

export function waitForExactSuggestion({ root = document, catcherDomain, timeoutMs = 10_000,
  pollMs = 100, scan = null, observerFactory = null } = {}) {
  const read = scan || (() => discoverSuggestionCandidates(root));
  const makeObserver = observerFactory || (typeof MutationObserver === 'function'
    ? (callback) => new MutationObserver(callback) : null);
  return new Promise((resolve) => {
    let finished = false; let timer = null; let poll = null; let observer = null;
    const done = (result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearInterval(poll); observer?.disconnect?.(); resolve(result);
    };
    const inspect = () => {
      const decision = exactSuggestionDecision(read(), catcherDomain);
      if (decision.status !== 'missing') done(decision);
    };
    observer = makeObserver?.(inspect) || null;
    observer?.observe?.(root.documentElement || root, { childList: true, subtree: true, attributes: true });
    poll = setInterval(inspect, Math.max(20, Number(pollMs) || 100));
    timer = setTimeout(() => done(exactSuggestionDecision(read(), catcherDomain)), Math.max(0, Number(timeoutMs) || 0));
    inspect();
  });
}

function eventFor(target, type, pointer = false) {
  const view = target?.ownerDocument?.defaultView || globalThis;
  const EventClass = pointer && typeof view.PointerEvent === 'function' ? view.PointerEvent : view.MouseEvent;
  return new EventClass(type, { bubbles: true, cancelable: true, composed: true, button: 0, buttons: type.endsWith('down') ? 1 : 0 });
}

export function dispatchSuggestionInteraction(element) {
  if (!visibleSuggestionElement(element)) return { clicked: false, reason: 'detached_or_hidden' };
  element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  element.focus?.({ preventScroll: true });
  for (const [type, pointer] of [['pointerdown', true], ['mousedown', false], ['mouseup', false], ['click', false]]) {
    element.dispatchEvent(eventFor(element, type, pointer));
  }
  return { clicked: true, reason: null };
}

export function dispatchExactSuggestionKeyboardFallback(input) {
  const view = input?.ownerDocument?.defaultView || globalThis;
  for (const key of ['ArrowDown', 'Enter']) {
    for (const type of ['keydown', 'keyup']) {
      input.dispatchEvent(new view.KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true }));
    }
  }
}
