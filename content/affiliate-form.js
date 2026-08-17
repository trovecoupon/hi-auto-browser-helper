(() => {
  if (globalThis.__HI_AUTO_AFFILIATE_FORM__) return;
  globalThis.__HI_AUTO_AFFILIATE_FORM__ = true;
  let stepIndex = 0;
  let modulePromise;
  let lastFingerprint = '';
  let scanPromise = null;
  let scanQueued = false;
  let rescanTimer = null;
  const autoFilledSteps = new Set();
  const helpers = () => (modulePromise ||= import(chrome.runtime.getURL('lib/form-assistant.mjs')));
  const send = (message) => new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (response?.ok === false) return reject(new Error(response.error || 'Browser Helper rejected the action.'));
    resolve(response);
  }));

  const fingerprint = (result) => JSON.stringify({
    surface: result.surface, frame_context: result.frame_context,
    popup_frame_origins: result.popup_frame_origins || [],
    fields: (result.fields || []).map((field) => [
      field.tag, field.type, field.name, field.label, field.placeholder, field.required,
      (field.options || []).map((option) => [option.value, option.label]),
    ]),
  });

  async function performScan({ force = false, advance = false } = {}) {
    const { scanForm, applyPlan, trackManualOverrides } = await helpers();
    trackManualOverrides(document);
    if (advance) stepIndex += 1;
    let result = scanForm(document, stepIndex);
    const nextFingerprint = fingerprint(result);
    if (!force && nextFingerprint === lastFingerprint) return { unchanged: true };
    if (!force && lastFingerprint && nextFingerprint !== lastFingerprint) {
      stepIndex += 1;
      result = scanForm(document, stepIndex);
    }
    lastFingerprint = fingerprint(result);
    const response = await send({ type: 'AFFILIATE_FORM_SCAN', scan: result });
    if (response?.ignored && Number(response.retry_after_ms) > 0) {
      setTimeout(() => scan({ force: true }).catch(() => {}), Math.min(Number(response.retry_after_ms), 5000));
      return response;
    }
    if (response?.auto_fill_plan) {
      // DOM observers may rescan the same step many times. Automatic filling is one-shot; afterwards
      // trusted keyboard/mouse edits own the field and background rescans cannot overwrite them.
      const autoFillKey = `${stepIndex}:${lastFingerprint}`;
      if (autoFilledSteps.has(autoFillKey)) return { ...response, auto_fill_skipped: 'already_applied' };
      autoFilledSteps.add(autoFillKey);
      const filled = applyPlan(response.auto_fill_plan, document);
      await send({ type: 'AFFILIATE_FORM_FILLED', result: filled });
      return { ...response, auto_fill_result: filled };
    }
    return response;
  }

  function scan(options = {}) {
    if (scanPromise) { scanQueued = true; return scanPromise; }
    scanPromise = performScan(options).finally(() => {
      scanPromise = null;
      if (scanQueued) { scanQueued = false; scheduleRescan(); }
    });
    return scanPromise;
  }

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => scan().catch((error) => send({
      type: 'AFFILIATE_FORM_ERROR', error_message: error.message,
    }).catch(() => {})), 700);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'AFFILIATE_APPLY_PLAN') {
      helpers().then(({ applyPlan }) => applyPlan(message.plan, document))
        .then(async (result) => {
          if (message.report !== false) await send({ type: 'AFFILIATE_FORM_FILLED', result });
          return result;
        })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'AFFILIATE_RESCAN') {
      scan({ force: true, advance: true }).then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'AFFILIATE_REFRESH_STATE') {
      scan({ force: true, advance: false }).then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });
  const observedRoots = new WeakSet();
  const observedFrames = new WeakSet();
  const observerOptions = {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['name', 'type', 'placeholder', 'aria-label', 'aria-labelledby', 'aria-hidden', 'hidden'],
  };
  function observeForms(root) {
    if (root && !observedRoots.has(root)) {
      observer.observe(root, observerOptions); observedRoots.add(root);
    }
    for (const host of root?.querySelectorAll?.('*') || []) {
      if (host.shadowRoot) observeForms(host.shadowRoot);
    }
    for (const frame of root?.querySelectorAll?.('iframe,frame') || []) {
      if (!observedFrames.has(frame)) {
        observedFrames.add(frame);
        frame.addEventListener('load', () => {
          try { observeForms(frame.contentDocument?.documentElement); } catch { /* Cross-origin frame. */ }
          scheduleRescan();
        });
      }
      try { observeForms(frame.contentDocument?.documentElement); } catch { /* Cross-origin frame has its own injected scanner. */ }
    }
  }
  const observer = new MutationObserver(() => { observeForms(document.documentElement); scheduleRescan(); });
  observeForms(document.documentElement);
  addEventListener('hashchange', scheduleRescan);
  addEventListener('popstate', scheduleRescan);
  setTimeout(() => scan({ force: true }).catch((error) => send({
    type: 'AFFILIATE_FORM_ERROR', error_message: error.message,
  }).catch(() => {})), 500);
})();
