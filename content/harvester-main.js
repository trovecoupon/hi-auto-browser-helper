(() => {
  const namespace = globalThis.__HI_AUTO_HARVESTER_NS__;
  const settings = globalThis.__HI_AUTO_HARVESTER_MAIN_CONFIG__ ?? {};
  try { delete globalThis.__HI_AUTO_HARVESTER_NS__; delete globalThis.__HI_AUTO_HARVESTER_MAIN_CONFIG__; } catch { /* best effort */ }
  if (!namespace || globalThis.__HI_AUTO_HARVESTER_MAIN__ === true) return;
  globalThis.__HI_AUTO_HARVESTER_MAIN__ = true;

  const unsafePage = () => /checkout|payment|bank|login|signin|sign-in/i.test(location.href)
    || Boolean(document.querySelector('input[type="password"]'));
  const emit = (rawCode, method, context = '') => {
    if (unsafePage() || typeof rawCode !== 'string' || !rawCode.trim() || rawCode.length > 200) return;
    window.postMessage({ namespace, source: 'hi-auto-main', candidates: [{ rawCode, method, context: String(context).slice(0, 300) }] }, location.origin);
  };
  const emitValue = (value, method, context = '') => {
    if (typeof value === 'string') emit(value, method, context);
    else if (Array.isArray(value)) value.slice(0, 100).forEach((item) => emitValue(item, method, context));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value).slice(0, 200)) {
        if (/^(?:(?:coupon|promo|voucher|discount|offer)_?)?code$|couponCode|voucher/i.test(key)) emitValue(item, method, key);
        else if (item && typeof item === 'object') emitValue(item, method, context);
      }
    }
  };

  // Clipboard hooks preserve the original function and report only the string the page itself writes.
  if (settings.clipboard !== false && navigator.clipboard?.writeText && !navigator.clipboard.writeText.__hiAutoHarvester) {
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    const wrapped = function writeText(value) { emit(String(value ?? ''), 'clipboard', 'navigator.clipboard.writeText'); return original(value); };
    Object.defineProperty(wrapped, '__hiAutoHarvester', { value: true });
    try { navigator.clipboard.writeText = wrapped; } catch { /* Browser may expose a readonly method. */ }
  }
  if (settings.clipboard !== false && navigator.clipboard?.write && !navigator.clipboard.write.__hiAutoHarvester) {
    const original = navigator.clipboard.write.bind(navigator.clipboard);
    const wrapped = function write(items) {
      for (const item of items ?? []) {
        if (item?.types?.includes?.('text/plain')) item.getType('text/plain').then((blob) => blob.text()).then((text) => emit(text, 'clipboard', 'ClipboardItem')).catch(() => {});
      }
      return original(items);
    };
    Object.defineProperty(wrapped, '__hiAutoHarvester', { value: true });
    try { navigator.clipboard.write = wrapped; } catch { /* readonly */ }
  }
  if (settings.clipboard !== false && document.execCommand && !document.execCommand.__hiAutoHarvester) {
    const original = document.execCommand.bind(document);
    const wrapped = function execCommand(command, ...args) {
      if (String(command).toLowerCase() === 'copy') emit(String(getSelection()?.toString() ?? ''), 'clipboard', 'execCommand(copy)');
      return original(command, ...args);
    };
    Object.defineProperty(wrapped, '__hiAutoHarvester', { value: true });
    try { document.execCommand = wrapped; } catch { /* readonly */ }
  }
  if (settings.clipboard !== false) document.addEventListener('copy', (event) => {
    try { emit(event.clipboardData?.getData('text/plain') ?? '', 'clipboard', 'copy event'); } catch { /* protected */ }
  }, true);

  // Network hooks inspect only small JSON/HTML responses and always return the untouched original response.
  if (settings.network !== false && globalThis.fetch && !globalThis.fetch.__hiAutoHarvester) {
    const original = globalThis.fetch;
    const wrapped = async function fetchWithCouponCapture(...args) {
      const response = await original.apply(this, args);
      try {
        const type = response.headers.get('content-type') ?? '';
        const length = Number(response.headers.get('content-length') || 0);
        if ((!length || length <= 2_000_000) && /json|html/i.test(type) && !unsafePage()) {
          const text = await response.clone().text();
          if (text.length <= 2_000_000) {
            if (/json/i.test(type)) { try { emitValue(JSON.parse(text), 'network', response.url); } catch { /* malformed JSON */ } }
            else window.postMessage({ namespace, source: 'hi-auto-main', html: text, method: 'network', context: response.url }, location.origin);
          }
        }
      } catch { /* Capture must never change fetch behavior. */ }
      return response;
    };
    Object.defineProperty(wrapped, '__hiAutoHarvester', { value: true });
    globalThis.fetch = wrapped;
  }

  if (settings.network !== false && globalThis.XMLHttpRequest && !XMLHttpRequest.prototype.open.__hiAutoHarvester) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    function open(method, url, ...args) { this.__hiAutoUrl = String(url ?? ''); return originalOpen.call(this, method, url, ...args); }
    function send(...args) {
      this.addEventListener('load', function captureXhr() {
        try {
          if (unsafePage()) return;
          const type = this.getResponseHeader('content-type') ?? '';
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          if (text.length > 2_000_000 || !/json|html/i.test(type)) return;
          if (/json/i.test(type)) { try { emitValue(JSON.parse(text), 'network', this.__hiAutoUrl); } catch { /* malformed */ } }
          else window.postMessage({ namespace, source: 'hi-auto-main', html: text, method: 'network', context: this.__hiAutoUrl }, location.origin);
        } catch { /* responseText may be unavailable */ }
      }, { once: true });
      return originalSend.apply(this, args);
    }
    Object.defineProperty(open, '__hiAutoHarvester', { value: true });
    XMLHttpRequest.prototype.open = open;
    XMLHttpRequest.prototype.send = send;
  }

  for (const method of settings.canvas === false ? [] : ['fillText', 'strokeText']) {
    const proto = globalThis.CanvasRenderingContext2D?.prototype;
    const original = proto?.[method];
    if (!original || original.__hiAutoHarvester) continue;
    const wrapped = function canvasText(text, ...args) { emit(String(text ?? ''), 'canvas', `canvas.${method}`); return original.call(this, text, ...args); };
    Object.defineProperty(wrapped, '__hiAutoHarvester', { value: true });
    proto[method] = wrapped;
  }
})();
