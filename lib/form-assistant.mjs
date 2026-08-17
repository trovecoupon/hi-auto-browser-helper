const UNSAFE = /(?:password|passcode|otp|one.?time|verification.?code|captcha|ssn|social.?security|tax.?id|vat|bank|iban|swift|routing|credit.?card|legal|terms|consent|agree|signature)/i;

const cleanText = (value, limit = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const manualOverrideKeys = new Set();
const trackedManualRoots = new WeakSet();

function humanizeName(value) {
  return cleanText(String(value || '')
    .replace(/\[|\]|\(|\)|_|-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b(?:data|input|field|answer)\b/gi, ' '));
}

function labelNodeText(node) {
  if (!node?.matches?.('label,legend,[data-name="label"],[class*="label" i],[class*="question" i]')) return '';
  return cleanText(node.innerText || node.textContent, 500);
}

function adjacentLabelText(element) {
  // React forms such as Partnerize render a label span beside an input wrapper instead of using <label for>.
  let current = element;
  for (let depth = 0; current && depth < 6; depth += 1, current = parentOrShadowHost(current)) {
    let previous = current.previousElementSibling;
    for (let offset = 0; previous && offset < 3; offset += 1, previous = previous.previousElementSibling) {
      const text = labelNodeText(previous);
      if (text) return text;
      if (previous.matches?.('input,textarea,select,[data-name="input"],[class*="inputform" i]')) break;
    }
  }
  return '';
}

export function fieldText(element) {
  const owner = element.ownerDocument || document;
  const labelled = [];
  if (element.labels) labelled.push(...[...element.labels].map((label) => label.innerText || label.textContent));
  const id = element.id && CSS.escape(element.id);
  if (id) labelled.push(...[...owner.querySelectorAll(`label[for="${id}"]`)]
    .map((label) => label.innerText || label.textContent));
  const labelledBy = cleanText(element.getAttribute('aria-labelledby'));
  if (labelledBy) labelled.push(...labelledBy.split(/\s+/).map((key) => {
    const node = owner.getElementById(key); return node?.innerText || node?.textContent;
  }));
  labelled.push(element.getAttribute('aria-label'), element.closest('label')?.innerText,
    element.closest('fieldset')?.querySelector('legend')?.innerText);
  const direct = labelled.map((value) => cleanText(value)).find(Boolean);
  if (direct) return direct.slice(0, 500);

  const adjacent = adjacentLabelText(element);
  if (adjacent) return adjacent;

  const nearby = [];
  let previous = element.previousElementSibling;
  for (let index = 0; previous && index < 3; index += 1, previous = previous.previousElementSibling) {
    if (previous.matches?.('label,legend,p,h1,h2,h3,h4,[class*="label" i],[class*="question" i]')) {
      nearby.push(previous.innerText || previous.textContent);
    }
  }
  const container = element.closest('[class*="field" i],[class*="form-group" i],[class*="question" i],[role="group"]');
  if (container) {
    // Do not take the first label from a plural whole-form container such as Partnerize `.Fields`.
    const controls = [...container.querySelectorAll('input,textarea,select')].filter(isVisible);
    if (controls.length <= 1) {
      const node = container.querySelector('label,legend,[data-name="label"],[class*="label" i],[class*="question" i],p');
      if (node && !node.contains(element)) nearby.push(node.innerText || node.textContent);
    }
  }
  const contextual = nearby.map((value) => cleanText(value)).find(Boolean);
  return (contextual || cleanText(element.placeholder) || humanizeName(element.name) || humanizeName(element.id)).slice(0, 500);
}

export function isUnsafeField(element, text = fieldText(element)) {
  const type = String(element.type || '').toLowerCase();
  return ['password', 'hidden', 'file', 'submit', 'button', 'reset', 'image'].includes(type)
    || UNSAFE.test(`${type} ${element.name || ''} ${element.id || ''} ${text}`);
}

function manualOverrideKey(element) {
  if (!element) return '';
  const label = (() => {
    try { return fieldText(element); } catch { return ''; }
  })();
  return [element.name, element.id, element.getAttribute?.('autocomplete'), element.type, label,
    element.dataset?.hiAutoField]
    .map((value) => cleanText(value, 300).toLowerCase())
    .join('\u001f');
}

function restoreHelperOutline(element) {
  if (!element?.dataset || !Object.hasOwn(element.dataset, 'hiAutoPreviousOutline')) return;
  element.style.outline = element.dataset.hiAutoPreviousOutline;
  delete element.dataset.hiAutoPreviousOutline;
}

export function markManualOverride(element) {
  if (!element?.matches?.('input,textarea,select')) return false;
  const key = manualOverrideKey(element);
  if (key) manualOverrideKeys.add(key);
  element.dataset.hiAutoManualOverride = 'true';
  delete element.dataset.hiAutoFilled;
  restoreHelperOutline(element);
  return true;
}

function clearManualOverride(element) {
  const key = manualOverrideKey(element);
  if (key) manualOverrideKeys.delete(key);
  delete element.dataset.hiAutoManualOverride;
}

export function isManuallyOverridden(element) {
  if (!element) return false;
  if (element.dataset?.hiAutoManualOverride === 'true') return true;
  const key = manualOverrideKey(element);
  return Boolean(key && manualOverrideKeys.has(key));
}

export function trackManualOverrides(root = document) {
  if (!root?.addEventListener || trackedManualRoots.has(root)) return;
  trackedManualRoots.add(root);
  const rememberTrustedEdit = (event) => {
    // Events emitted by applyPlan are synthetic. Only a real keyboard/mouse/paste action owns the field.
    if (event.isTrusted) markManualOverride(event.target);
  };
  root.addEventListener('beforeinput', rememberTrustedEdit, true);
  root.addEventListener('input', rememberTrustedEdit, true);
  root.addEventListener('change', rememberTrustedEdit, true);
}

function hasExistingValue(element) {
  const type = String(element?.type || '').toLowerCase();
  if (['checkbox', 'radio'].includes(type)) return Boolean(element.checked);
  return String(element?.value ?? '').trim().length > 0;
}

export function preservationReason(element, plan = {}) {
  if (!plan.overwrite_manual && isManuallyOverridden(element)) return 'manual_override';
  if (!plan.overwrite_existing && element?.dataset?.hiAutoFilled !== 'true' && hasExistingValue(element)) {
    return 'existing_value';
  }
  return '';
}

function parentOrShadowHost(node) {
  return node?.parentElement || node?.getRootNode?.()?.host || null;
}

function isVisible(element) {
  for (let current = element; current; current = parentOrShadowHost(current)) {
    if (current.hidden || current.inert || current.getAttribute?.('aria-hidden') === 'true') return false;
    try {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    } catch { return false; }
  }
  return true;
}

function deepQuery(root, selector, { includeFrames = true } = {}) {
  const found = [...root.querySelectorAll(selector)];
  for (const host of root.querySelectorAll('*')) {
    if (host.shadowRoot) found.push(...deepQuery(host.shadowRoot, selector, { includeFrames }));
  }
  if (includeFrames) {
    for (const frame of root.querySelectorAll('iframe,frame')) {
      if (!isVisible(frame)) continue;
      try {
        if (frame.contentDocument) found.push(...deepQuery(frame.contentDocument, selector, { includeFrames }));
      } catch { /* Cross-origin popup frames are injected separately after explicit host permission. */ }
    }
  }
  return [...new Set(found)];
}

function popupSurface(root) {
  const selector = 'dialog[open],[aria-modal="true"],[role="dialog"],[class*="modal" i],[class*="popup" i]';
  const candidates = deepQuery(root, selector).filter((node) => isVisible(node)
    && (deepQuery(node, 'input,textarea,select').some(isVisible)
      || deepQuery(node, 'iframe,frame', { includeFrames: false }).some(isVisible)));
  return candidates.at(-1) || null;
}

function blockedFrameOrigins(root) {
  const origins = [];
  for (const frame of deepQuery(root, 'iframe,frame', { includeFrames: false })) {
    if (!isVisible(frame)) continue;
    try {
      if (frame.contentDocument) continue;
    } catch { /* Expected for cross-origin frames. */ }
    try {
      const origin = new URL(frame.src, location.href).origin;
      if (/^https:\/\//.test(origin) && origin !== location.origin) origins.push(`${origin}/*`);
    } catch { /* Ignore invalid or opaque iframe URLs. */ }
  }
  return [...new Set(origins)].slice(0, 10);
}

function deepFormControls(root) {
  return deepQuery(root, 'input,textarea,select');
}

export function scanForm(root = document, stepIndex = 0) {
  const popup = popupSurface(root);
  const surface = popup || root;
  // Hidden/action controls không phải câu hỏi để Helper hỗ trợ và không được tính là "điền thiếu".
  const nodes = deepFormControls(surface).filter((element) => {
    if (element.disabled || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(String(element.type || '').toLowerCase())) return false;
    return isVisible(element);
  });
  const fields = nodes.map((element, index) => {
    const domId = `haf_${stepIndex}_${index}`;
    element.dataset.hiAutoField = domId;
    const label = fieldText(element);
    return {
      dom_id: domId, tag: element.tagName.toLowerCase(), type: String(element.type || '').toLowerCase(),
      name: String(element.name || '').slice(0, 200), label, placeholder: String(element.placeholder || '').slice(0, 300),
      aria_label: String(element.getAttribute('aria-label') || '').slice(0, 300), required: Boolean(element.required),
      maxlength: Number(element.maxLength) > 0 ? Number(element.maxLength) : null,
      options: element.tagName === 'SELECT' ? [...element.options].slice(0, 200).map((option) => ({
        value: option.value, label: option.textContent?.trim(), disabled: option.disabled,
      })) : [], unsafe: isUnsafeField(element, label),
    };
  });
  const buttons = deepQuery(surface, 'button,input[type="submit"],[role="button"]')
    .map((node) => `${node.innerText || node.value || ''} ${node.getAttribute('aria-label') || ''}`.trim());
  return {
    url: location.href, title: document.title, step_index: stepIndex, fields,
    surface: popup ? 'popup' : 'page', frame_context: window.top === window ? 'top' : 'embedded',
    popup_frame_origins: popup ? blockedFrameOrigins(popup) : [],
    captcha_present: Boolean(deepQuery(surface, 'iframe[src*="captcha" i],iframe[title*="captcha" i],[class*="captcha" i],[id*="captcha" i]').length),
    next_present: buttons.some((text) => /^(?:next|continue|tiếp|tiếp tục|sau)$/i.test(text)),
    submit_present: buttons.some((text) => /(?:submit|apply|send application|nộp|gửi đơn|đăng ký)/i.test(text)),
  };
}

function setNative(element, value) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(element, value); else element.value = value;
}

const localSecretGroups = new Map();
const localSecretFallbackBound = new WeakSet();

function passwordCandidateFits(element, value) {
  const text = String(value || '');
  if (Number(element.minLength) > 0 && text.length < Number(element.minLength)) return false;
  if (Number(element.maxLength) > 0 && text.length > Number(element.maxLength)) return false;
  const pattern = element.getAttribute('pattern');
  if (pattern) {
    try { if (!new RegExp(`^(?:${pattern})$`, 'u').test(text)) return false; } catch { /* Site pattern is invalid; browser ignores it too. */ }
  }
  return true;
}

function dispatchFilledEvents(element) {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillLocalSecret(element, item) {
  const groupKey = String(item.local_secret_group || 'affiliate_password');
  const candidates = [...new Set((item.value_candidates || [item.value]).map(String).filter(Boolean))];
  if (!candidates.length) return null;
  let state = localSecretGroups.get(groupKey);
  if (!state) {
    state = { candidates, index: 0, elements: new Set() };
    localSecretGroups.set(groupKey, state);
  } else {
    state.candidates = [...new Set([...state.candidates, ...candidates])];
  }
  state.elements.add(element);
  const fitsAll = (candidate) => [...state.elements].every((target) => passwordCandidateFits(target, candidate));
  let index = state.index;
  if (!fitsAll(state.candidates[index])) {
    index = state.candidates.findIndex(fitsAll);
    if (index < 0) index = state.index;
  }
  state.index = index;
  const applyCandidate = () => {
    const candidate = state.candidates[state.index];
    for (const target of state.elements) {
      setNative(target, candidate);
      dispatchFilledEvents(target);
    }
  };
  const advanceCandidate = () => {
    const next = state.candidates.findIndex((candidate, candidateIndex) => candidateIndex > state.index && fitsAll(candidate));
    if (next < 0) return false;
    state.index = next;
    queueMicrotask(applyCandidate);
    return true;
  };
  if (!localSecretFallbackBound.has(element)) {
    localSecretFallbackBound.add(element);
    element.addEventListener('invalid', advanceCandidate, true);
  }
  applyCandidate();
  // Many affiliate forms validate passwords asynchronously and only mark the field invalid instead of
  // firing a useful error callback. Check once after their input handlers settle and switch the whole pair.
  setTimeout(() => {
    const rejected = element.getAttribute('aria-invalid') === 'true'
      || /(?:^|\s)(?:error|invalid)(?:\s|$)/i.test(String(element.className || ''))
      || (() => { try { return element.matches(':invalid'); } catch { return false; } })();
    if (rejected) advanceCandidate();
  }, 180);
  return state.candidates[state.index];
}

function findScannedField(root, domId) {
  const selector = `[data-hi-auto-field="${CSS.escape(domId)}"]`;
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const host of root.querySelectorAll('*')) {
    if (!host.shadowRoot) continue;
    const nested = findScannedField(host.shadowRoot, domId);
    if (nested) return nested;
  }
  for (const frame of root.querySelectorAll('iframe,frame')) {
    try {
      if (!frame.contentDocument) continue;
      const nested = findScannedField(frame.contentDocument, domId);
      if (nested) return nested;
    } catch { /* A separately injected cross-origin frame applies its own plan. */ }
  }
  return null;
}

export function applyPlan(plan, root = document) {
  const filled = [], skipped = [];
  for (const item of plan?.fields || []) {
    const element = findScannedField(root, item.dom_id);
    const localSecret = item.locally_managed_secret === true && String(element?.type || '').toLowerCase() === 'password';
    if (!element || element.disabled || element.readOnly || (isUnsafeField(element) && !localSecret)
        || (item.sensitive && !item.confirmed_sensitive)) {
      skipped.push({ dom_id: item.dom_id, reason: 'missing_or_unsafe' }); continue;
    }
    const preserve = preservationReason(element, plan);
    if (preserve) { skipped.push({ dom_id: item.dom_id, reason: preserve }); continue; }
    if (plan.overwrite_manual) clearManualOverride(element);
    const value = String(item.value ?? '');
    if (element instanceof HTMLSelectElement) {
      const target = [...element.options].find((option) => option.value.toLowerCase() === value.toLowerCase()
        || option.textContent.trim().toLowerCase() === value.toLowerCase());
      if (!target) { skipped.push({ dom_id: item.dom_id, reason: 'option_not_found' }); continue; }
      element.value = target.value;
    } else if (['checkbox', 'radio'].includes(String(element.type).toLowerCase())) {
      if (!/^(?:1|true|yes|on)$/i.test(value)) { skipped.push({ dom_id: item.dom_id, reason: 'not_explicit_true' }); continue; }
      element.checked = true;
    } else if (localSecret) {
      if (!fillLocalSecret(element, item)) { skipped.push({ dom_id: item.dom_id, reason: 'secret_unavailable' }); continue; }
    } else {
      setNative(element, value.slice(0, element.maxLength > 0 ? element.maxLength : 10000));
    }
    if (!localSecret) dispatchFilledEvents(element);
    if (!Object.hasOwn(element.dataset, 'hiAutoPreviousOutline')) {
      element.dataset.hiAutoPreviousOutline = element.style.outline || '';
    }
    element.style.outline = '2px solid #2f9e67';
    element.dataset.hiAutoFilled = 'true';
    filled.push({ dom_id: item.dom_id, field_key: item.field_key });
  }
  return { filled, skipped };
}
