const LAYERS = {
  text: 'Văn bản, DOM sâu và pseudo-element', clickdiff: 'DOM thay đổi sau thao tác thật',
  clipboard: 'Clipboard của trang', network: 'JSON/HTML từ fetch và XHR',
  canvas: 'Text vẽ lên canvas', url: 'Query/hash và tab mới', rules: 'Rule theo domain',
  overlay: 'Thông báo trên trang', ocr: 'OCR local (chậm, chỉ fallback)',
};
const send = (message) => chrome.runtime.sendMessage(message);

async function render() {
  const response = await send({ type: 'HARVESTER_GET_STATE' });
  const state = response.harvester;
  const settings = document.querySelector('[data-settings]'); settings.replaceChildren();
  for (const [key, label] of Object.entries(LAYERS)) {
    const row = document.createElement('label'); const input = document.createElement('input');
    input.type = 'checkbox'; input.dataset.layer = key; input.checked = state.settings[key] !== false;
    row.append(input, document.createTextNode(label)); settings.append(row);
  }
  document.querySelector('[data-count]').textContent = state.coupons.length;
  document.querySelector('[data-allow]').value = (state.settings.allowCodes || []).join('\n');
  document.querySelector('[data-block]').value = (state.settings.blockCodes || []).join('\n');
  document.querySelector('[data-domain]').value = JSON.stringify(state.settings.domainOverrides || {}, null, 2);
  const rules = document.querySelector('[data-rules]'); rules.replaceChildren();
  for (const rule of state.rules) {
    const row = document.createElement('article'); const text = document.createElement('div');
    const host = document.createElement('b'); host.textContent = rule.hostname;
    const selector = document.createElement('code'); selector.textContent = rule.codeSelector;
    text.append(host, document.createElement('br'), selector);
    const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Xóa';
    remove.onclick = async () => { await send({ type: 'HARVESTER_DELETE_RULE', rule_id: rule.id }); render(); };
    row.append(text, remove); rules.append(row);
  }
}

document.querySelector('[data-save]').onclick = async () => {
  const message = document.querySelector('[data-message]');
  try {
    const settings = Object.fromEntries([...document.querySelectorAll('[data-layer]')].map((input) => [input.dataset.layer, input.checked]));
    settings.allowCodes = document.querySelector('[data-allow]').value.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
    settings.blockCodes = document.querySelector('[data-block]').value.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
    settings.domainOverrides = JSON.parse(document.querySelector('[data-domain]').value || '{}');
    await send({ type: 'HARVESTER_UPDATE_SETTINGS', settings }); message.textContent = 'Đã lưu.';
  } catch (error) { message.textContent = `Lỗi: ${error.message}`; }
};
document.querySelector('[data-clear]').onclick = async () => {
  if (confirm('Xóa toàn bộ coupon đã bắt trên máy này?')) { await send({ type: 'HARVESTER_CLEAR' }); render(); }
};
render();
