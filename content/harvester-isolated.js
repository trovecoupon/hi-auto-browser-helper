(() => {
  const config = globalThis.__HI_AUTO_HARVESTER_CONFIG__;
  const namespace = config?.namespace;
  if (!namespace || globalThis.__HI_AUTO_HARVESTER_ISOLATED__ === namespace) return;
  globalThis.__HI_AUTO_HARVESTER_ISOLATED__ = namespace;

  const LABEL = /(?:promo(?:tional)?|coupon|voucher|discount|offer)\s+code|(?:use|apply|enter)\s+(?:the\s+)?(?:(?:promo(?:tional)?|coupon|voucher|discount)\s+)?code|mã\s+(?:giảm\s+giá|khuyến\s+mãi|ưu\s+đãi)|(?:kortings|rabatt)code/iu;
  const TOKEN = `[A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9]`;
  const AFTER = new RegExp(`(?:${LABEL.source})\\s*(?:is|là|as)?\\s*[:=\\-–—]?\\s*["'“”‘’]?(?:the\\s+)?(${TOKEN})["'“”‘’]?`, 'giu');
  const BEFORE = new RegExp(`["'“”‘’]?(${TOKEN})["'“”‘’]?\\s*(?:is|là|as)?\\s*(?:a|the)?\\s*(?:${LABEL.source})`, 'giu');
  const seen = new Map();
  let clickTarget = null;
  let clickDeadline = 0;
  let scanTimer = null;
  let pickerMode = false;
  let hoverTarget = null;
  let overlay;
  const ocrRequested = new Set();

  const safeUrl = () => !/checkout|payment|bank|login|signin|sign-in/i.test(location.href) && !document.querySelector('input[type="password"]');
  const hostname = location.hostname.toLowerCase();
  const now = () => Date.now();
  const sendQuietly = (message) => {
    try {
      if (typeof chrome.runtime?.sendMessage !== 'function') return;
      const pending = chrome.runtime.sendMessage(message);
      pending?.catch?.(() => {});
    } catch { /* Extension vừa Reload/Update: dừng im lặng, bản content mới sẽ được bơm lại. */ }
  };
  const compact = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const couponContainer = (node) => node?.closest?.('[class*="coupon" i],[id*="coupon" i],[class*="promo" i],[id*="promo" i],[class*="voucher" i],[class*="offer" i],article,li,tr,section') ?? node?.parentElement;
  const contextFor = (node, fallback = '') => compact(couponContainer(node)?.innerText || fallback || node?.textContent).slice(0, 300);
  const titleFor = (node) => compact(couponContainer(node)?.querySelector?.('h1,h2,h3,h4,strong,b')?.textContent || '').slice(0, 180);
  const styleFor = (node) => {
    try {
      const style = getComputedStyle(node);
      const signal = `${node.className ?? ''} ${node.id ?? ''}`;
      return {
        monospace: /mono|courier|consolas/i.test(style.fontFamily), dashedBorder: style.borderStyle === 'dashed',
        highlighted: style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent',
        semanticClass: /coupon|promo|code|voucher/i.test(signal),
      };
    } catch { return {}; }
  };

  function sendCandidates(candidates) {
    const output = [];
    for (const candidate of candidates) {
      const key = `${candidate.rawCode.toUpperCase()}|${candidate.detectedBy.join('+')}`;
      const prior = seen.get(key);
      if (prior && now() - prior < 1500) continue;
      seen.set(key, now()); output.push(candidate);
    }
    if (!output.length) return;
    sendQuietly({ type: 'HARVESTER_CANDIDATES', namespace, candidates: output });
  }

  function makeCandidate(rawCode, method, node, context = '', extra = {}) {
    const value = compact(rawCode).replace(/^["'“”‘’`]+|["'“”‘’`,.;:!?]+$/gu, '');
    if (value.length < 3 || value.length > 80) return null;
    return {
      rawCode: value, hostname, sourceUrl: location.href, context: contextFor(node, context),
      offerTitle: titleFor(node), detectedBy: [method], firstSeen: now(), lastSeen: now(),
      occurrenceCount: Math.min(100, (document.body?.innerText.match(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')) ?? []).length),
      explicitLabel: Boolean(extra.explicitLabel), nearKeyword: Boolean(extra.nearKeyword),
      style: styleFor(node), ...extra,
    };
  }

  function candidatesFromText(text, method, node, context = '') {
    const value = compact(text);
    if (!value || value.length > 20_000) return [];
    const result = [];
    for (const pattern of [AFTER, BEFORE]) {
      pattern.lastIndex = 0;
      for (const match of value.matchAll(pattern)) {
        if (pattern === BEFORE && !/[0-9_-]/.test(match[1]) && match[1] !== match[1].toUpperCase()) continue;
        const candidate = makeCandidate(match[1], method, node, context || value, { explicitLabel: true, nearKeyword: true });
        if (candidate) result.push(candidate);
      }
    }
    return result;
  }

  function roots(root = document) {
    const output = [root];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const element = walker.currentNode;
      if (element.shadowRoot) output.push(...roots(element.shadowRoot));
      if (element.tagName === 'IFRAME') { try { if (element.contentDocument) output.push(...roots(element.contentDocument)); } catch { /* cross-origin is injected per frame */ } }
      if (element.tagName === 'TEMPLATE' && element.content) output.push(element.content);
      if (element.tagName === 'SLOT') for (const assigned of element.assignedNodes?.({ flatten: true }) ?? []) if (assigned.nodeType === Node.ELEMENT_NODE) output.push(assigned);
    }
    return output;
  }

  function scanRoot(root, method) {
    const candidates = [];
    const elements = root.querySelectorAll?.('h1,h2,h3,h4,h5,h6,p,li,td,th,label,button,input,code,pre,[data-code],[data-coupon],[data-promo],[data-voucher],[data-clipboard-text]') ?? [];
    for (const element of elements) {
      try {
        const visual = getComputedStyle(element);
        if (/blur\s*\([^)]*[1-9]/i.test(visual.filter) || (visual.webkitTextSecurity && visual.webkitTextSecurity !== 'none')) continue;
      } catch { /* detached node */ }
      const text = compact(element.innerText || element.textContent || '');
      if ((element.matches('code,pre') && LABEL.test(contextFor(element)))
          || (element.matches('input') && (element.readOnly || element.disabled))) {
        const direct = makeCandidate(element.value || text, method, element, contextFor(element), { explicitLabel: true, nearKeyword: true });
        if (direct) candidates.push(direct);
      }
      if (LABEL.test(text)) candidates.push(...candidatesFromText(text, method, element));
      for (const attr of element.getAttributeNames?.() ?? []) {
        const relevant = /^(?:alt|title|aria-label|placeholder)$/i.test(attr)
          || (/^data-/i.test(attr) && /code|coupon|voucher|promo|clipboard/i.test(attr))
          || (attr === 'value' && (element.readOnly || element.disabled));
        if (!relevant) continue;
        const attrValue = element.getAttribute(attr) ?? element.value ?? '';
        if (/code|coupon|voucher|promo|clipboard/i.test(attr)) {
          const candidate = makeCandidate(attrValue, method, element, `${attr}=${attrValue}`, { explicitLabel: true, nearKeyword: true, style: { ...styleFor(element), semanticClass: true } });
          if (candidate) candidates.push(candidate);
        }
        candidates.push(...candidatesFromText(attrValue, method, element, attr));
      }
      for (const pseudo of ['::before', '::after']) {
        try {
          const content = getComputedStyle(element, pseudo).content?.replace(/^['"]|['"]$/g, '');
          if (content && content !== 'none' && content !== 'normal') candidates.push(...candidatesFromText(content, method, element, pseudo));
        } catch { /* unsupported pseudo style */ }
      }
    }
    return candidates;
  }

  function applyRules() {
    const candidates = [];
    for (const rule of config.rules ?? []) {
      if (rule.hostname !== hostname || rule.stale) continue;
      let matched = [];
      try { matched = [...document.querySelectorAll(rule.codeSelector)]; } catch {
        sendQuietly({ type: 'HARVESTER_RULE_STALE', namespace, rule_id: rule.id, reason: 'invalid_selector' });
        continue;
      }
      if (!matched.length) sendQuietly({ type: 'HARVESTER_RULE_STALE', namespace, rule_id: rule.id, reason: 'selector_no_match' });
      for (const element of matched) {
        const candidate = makeCandidate(element.value || element.textContent, 'rule', element, '', { explicitLabel: true, nearKeyword: true });
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates;
  }

  function scan(method = 'text') {
    if (!safeUrl()) return;
    const candidates = [];
    if (config.settings?.rules !== false) candidates.push(...applyRules());
    if (config.settings?.text !== false || method === 'clickdiff') for (const root of roots()) candidates.push(...scanRoot(root, method));
    if (config.settings?.url !== false) {
      const url = new URL(location.href);
      const pairs = [...url.searchParams];
      const hash = url.hash.slice(1); if (hash) pairs.push(...new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash));
      for (const [key, value] of pairs) if (/coupon|promo|voucher|discount|offer|code/i.test(key)) {
        const candidate = makeCandidate(value, 'url', document.documentElement, `${key}=${value}`, { explicitLabel: true, nearKeyword: true });
        if (candidate) candidates.push(candidate);
      }
    }
    sendCandidates(candidates);
    if (!candidates.length && config.settings?.ocr === true && safeUrl()) requestOcrFallback();
  }

  function requestOcrFallback() {
    for (const element of document.querySelectorAll('img,canvas,svg')) {
      const region = couponContainer(element);
      const nearby = compact(region?.innerText || element.getAttribute?.('alt') || element.getAttribute?.('title') || '');
      if (!LABEL.test(nearby)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10 || rect.bottom < 0 || rect.top > innerHeight) continue;
      const key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
      if (ocrRequested.has(key)) continue;
      ocrRequested.add(key);
      sendQuietly({
        type: 'HARVESTER_OCR_REQUEST', namespace,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        dpr: devicePixelRatio || 1, context: nearby.slice(0, 300), sourceUrl: location.href,
      });
      break;
    }
  }

  function schedule(method) { clearTimeout(scanTimer); scanTimer = setTimeout(() => scan(method), 180); }
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => mutation.type !== 'attributes' || /^(?:class|style|value|data-)/i.test(mutation.attributeName ?? ''));
    if (relevant) schedule(clickDeadline > now() && clickTarget ? 'clickdiff' : 'text');
  });
  const observe = () => document.documentElement && observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe, { once: true });

  const trustedGesture = (event) => {
    if (!event.isTrusted) return;
    clickTarget = event.target; clickDeadline = now() + 8000;
    setTimeout(() => { if (now() >= clickDeadline) { clickTarget = null; scan('clickdiff'); } }, 8000);
  };
  document.addEventListener('click', trustedGesture, true);
  document.addEventListener('pointerup', trustedGesture, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Enter') trustedGesture(event); }, true);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.namespace !== namespace || event.data?.source !== 'hi-auto-main' || !safeUrl()) return;
    const method = event.data.method ?? event.data.candidates?.[0]?.method ?? 'network';
    if (event.data.html) sendCandidates(candidatesFromText(compact(event.data.html.replace(/<[^>]+>/g, ' ')), method, document.body, event.data.context));
    const candidates = (event.data.candidates ?? []).flatMap((item) => {
      const direct = makeCandidate(item.rawCode, item.method ?? method, clickTarget || document.body, item.context, {
        explicitLabel: ['clipboard', 'network', 'canvas'].includes(item.method), nearKeyword: item.method === 'network',
      });
      return direct ? [direct] : [];
    });
    sendCandidates(candidates);
  });

  function selectorFor(element) {
    for (const attr of element.getAttributeNames()) if (/^data-(?:coupon|promo|voucher|code)/i.test(attr)) return `[${CSS.escape(attr)}]`;
    if (element.id && !/\d{4,}|[a-f0-9]{12,}/i.test(element.id)) return `#${CSS.escape(element.id)}`;
    const stable = [...element.classList].find((name) => !/\d{4,}|[a-f0-9]{12,}/i.test(name));
    if (stable) return `${element.tagName.toLowerCase()}.${CSS.escape(stable)}`;
    const parts = []; let node = element;
    while (node?.parentElement && parts.length < 5) {
      const siblings = [...node.parentElement.children].filter((item) => item.tagName === node.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''}`); node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function pickerMove(event) { if (!pickerMode) return; if (hoverTarget) hoverTarget.style.outline = ''; hoverTarget = event.target; hoverTarget.style.outline = '3px solid #6d5ef6'; }
  function pickerClick(event) {
    if (!pickerMode || !event.isTrusted) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (hoverTarget) hoverTarget.style.outline = '';
    pickerMode = false;
    const rule = { hostname, codeSelector: selectorFor(event.target), offerSelector: '', descSelector: '', source: 'learned' };
    sendQuietly({ type: 'HARVESTER_SAVE_RULE', namespace, rule });
  }
  document.addEventListener('mousemove', pickerMove, true);
  document.addEventListener('click', pickerClick, true);

  function showOverlay(count, review = false) {
    if (config.settings?.overlay === false || !document.documentElement) return;
    if (!overlay) {
      overlay = document.createElement('div'); overlay.id = 'hi-auto-coupon-harvester';
      Object.assign(overlay.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647', padding: '11px 14px', borderRadius: '10px', background: '#161a2b', color: '#fff', font: '600 13px/1.3 system-ui', boxShadow: '0 8px 28px rgba(0,0,0,.28)', cursor: 'pointer' });
      overlay.addEventListener('click', () => sendQuietly({ type: 'HARVESTER_OPEN_PANEL' }));
      document.documentElement.append(overlay);
    }
    overlay.textContent = review ? `Hi Auto bắt được ${count} mã · cần xem lại` : `Hi Auto đã bắt được ${count} mã · mở bảng`;
    clearTimeout(overlay.__timer); overlay.__timer = setTimeout(() => overlay?.remove(), 8000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'HARVESTER_SCAN_NOW') { scan(message.method ?? 'text'); respond({ ok: true }); }
    else if (message?.type === 'HARVESTER_PICKER') { pickerMode = Boolean(message.enabled); respond({ ok: true }); }
    else if (message?.type === 'HARVESTER_NOTIFY') { showOverlay(message.count ?? 1, message.review); respond({ ok: true }); }
    return false;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan('text'), { once: true });
  else scan('text');
})();
