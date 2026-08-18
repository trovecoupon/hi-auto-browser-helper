import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const worker = read('service-worker.js');
const main = read('content/harvester-main.js');
const isolated = read('content/harvester-isolated.js');
const panel = read('sidepanel/panel.html');
const ocr = read('offscreen/ocr.js');

test('Harvester 2.1 manifest and local OCR assets are wired', () => {
  // Version doi moi lan phat hanh nen chi kiem tra dang. Dong nay tung ghim
  // '3.0.3' va lam CI do o MOI ban moi, nen viec phat hanh phai lam tay.
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.equal(manifest.options_page, 'options/options.html');
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
  for (const path of ['vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js', 'vendor/tesseract/lang/eng.traineddata.gz']) {
    assert.ok(readFileSync(new URL(path, root)).length > 100, path);
  }
  assert.doesNotMatch(ocr, /https?:\/\//);
});

test('MAIN-world hooks are idempotent, bounded and suppress sensitive pages', () => {
  assert.match(main, /__HI_AUTO_HARVESTER_MAIN__/);
  assert.match(main, /clipboard\.writeText/);
  assert.match(main, /globalThis\.fetch/);
  assert.match(main, /XMLHttpRequest/);
  assert.match(main, /CanvasRenderingContext2D/);
  assert.match(main, /2_000_000/);
  assert.match(main, /checkout\|payment\|bank\|login/);
  assert.match(main, /input\[type="password"\]/);
});

test('isolated scanner covers trusted click-diff, deep DOM, URL, picker and OCR fallback', () => {
  assert.match(isolated, /MutationObserver/);
  assert.match(isolated, /event\.isTrusted/);
  assert.match(isolated, /shadowRoot/);
  assert.match(isolated, /contentDocument/);
  assert.match(isolated, /::before/);
  assert.match(isolated, /HARVESTER_PICKER/);
  assert.match(isolated, /HARVESTER_OCR_REQUEST/);
  assert.match(isolated, /URLSearchParams/);
});

test('service worker uses passive source reading, keeps child tabs and exposes review/export UI', () => {
  assert.match(worker, /content\/coupon-source-read\.js/);
  assert.doesNotMatch(worker, /delegated: 'content\/coupon-source\.js'/);
  assert.match(worker, /tabs\.onCreated/);
  assert.match(worker, /HARVESTER_CANDIDATES/);
  assert.match(worker, /HARVESTER_EXPORT/);
  assert.match(panel, /Coupon Harvester/);
  assert.match(panel, /Export JSON/);
  assert.match(panel, /data-layer="ocr"/);
});

test('Affiliate Side Panel can restore a durable job and its exact form tab after reopening', () => {
  assert.match(worker, /affiliate-helper\/jobs\/current/);
  assert.match(worker, /RECOVER_AFFILIATE_APPLICATION/);
  assert.match(worker, /recoverAffiliateApplication/);
  assert.match(worker, /REFRESH_AFFILIATE_CURRENT_STATE/);
  assert.match(panel, /data-act="refresh-affiliate-state"/);
  assert.doesNotMatch(panel, /data-act="rescan-affiliate"/);
});

test('Affiliate password remains editable while automatic candidates stay available', () => {
  const panelScript = read('sidepanel/panel.js');
  assert.match(worker, /has_custom_password/);
  assert.match(panelScript, /Lưu mật khẩu mới & điền lại/);
  assert.match(panelScript, /Đang dùng mật khẩu tự động — có thể đổi/);
  assert.match(panelScript, /LEARN_AFFILIATE_LOCAL_SECRET/);
});

test('Affiliate fields already filled by Helper remain editable from the Side Panel', () => {
  const panelScript = read('sidepanel/panel.js');
  assert.match(panel, /data-aff-editable/);
  assert.match(panel, /Sửa trường đã điền/);
  assert.match(panelScript, /item\.field_signature && !item\.sensitive/);
  assert.match(panelScript, /Lưu sửa & điền lại/);
  assert.match(panelScript, /type: 'LEARN_AFFILIATE_ANSWER'/);
});
