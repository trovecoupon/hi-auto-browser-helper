// Loaded dynamically by each content script; kept free of automatic collection behavior.
export function sendRuntimeMessage(payload, runtime = chrome.runtime) {
  return new Promise((resolve, reject) => {
    try {
      if (!runtime?.id) return reject(new Error('Extension context invalidated'));
      runtime.sendMessage(payload, (response) => {
        let runtimeError = null;
        try { runtimeError = runtime.lastError?.message ?? null; }
        catch { return reject(new Error('Extension context invalidated')); }
        if (runtimeError) return reject(new Error(runtimeError || 'Browser Helper runtime message failed'));
        if (!response || typeof response !== 'object') return reject(new Error('Browser Helper returned an empty or invalid response. Reload the extension and this page.'));
        if (response.error) return reject(new Error(response.error));
        resolve(response);
      });
    } catch (error) { reject(error); }
  });
}

export function finalizeUserAction(button, observer, navigating = false) {
  observer?.disconnect?.();
  if (!navigating && button) button.disabled = false;
}

globalThis.DiscoveryHelperUi = {
  async mount(title) {
    const extensionVersion = chrome.runtime.getManifest().version;
    const existing = document.querySelector('#discovery-helper');
    if (existing?.dataset.helperVersion === extensionVersion) return existing;
    existing?.remove();
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = chrome.runtime.getURL('content/overlay.css'); document.documentElement.append(link);
    const root = document.createElement('aside'); root.id = 'discovery-helper';
    root.dataset.helperVersion = extensionVersion;
    root.innerHTML = `<h3>${title} · v${extensionVersion}</h3><p data-status>Ready for a user action.</p><div data-controls></div>`; document.documentElement.append(root); return root;
  },
  status(root, text, error = false) { const node = root.querySelector('[data-status]'); node.textContent = text; node.className = error ? 'error' : 'ok'; },
  message(payload) { return sendRuntimeMessage(payload); },
  finalizeUserAction
};
