import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(here, '..', 'service-worker.js'), 'utf8');
const panel = readFileSync(join(here, '..', 'sidepanel', 'panel.js'), 'utf8');
const panelHtml = readFileSync(join(here, '..', 'sidepanel', 'panel.html'), 'utf8');
const hiAutoPath = join(here, '..', '..', '..', '..', 'ui', 'frontend', 'src', 'CouponDiscoveryPanel.jsx');
const bridgePath = join(here, '..', '..', '..', '..', 'ui', 'frontend', 'src', 'browserHelper.js');
const hasMonorepoUi = existsSync(hiAutoPath) && existsSync(bridgePath);
const hiAuto = hasMonorepoUi ? readFileSync(hiAutoPath, 'utf8') : '';
const bridge = hasMonorepoUi ? readFileSync(bridgePath, 'utf8') : '';
const monorepoTest = hasMonorepoUi ? test : test.skip;

monorepoTest('run-all queues the backend snapshot instead of transporting an unbounded ID list', () => {
  assert.match(panelHtml, /data-act="run-all">Chạy tất cả/);
  assert.match(panel, /'run-all': \(\) => send\(\{ type: 'COUPON_QUEUE_RUN', all: true/);
  assert.match(worker, /message\.all === true/);
  assert.match(worker, /coupon-discovery\/jobs\/all/);
  assert.match(bridge, /runAllCouponProjects/);
  assert.match(hiAuto, /Chạy toàn bộ phù hợp \{projects\.total \|\| ''\}/);
  assert.match(worker, /only.*affiliate_fit/);
});

monorepoTest('all modes accept one useful code and remain hard-bounded at ten', () => {
  assert.match(worker, /Math\.max\(1, Math\.min\(Number\(message\.target_count\)[\s\S]*10, 10\)\)/);
  assert.match(readFileSync(join(here, 'coupon-job-runner.mjs'), 'utf8'), /MIN_USEFUL_COUPONS = 1/);
  assert.match(worker, /searchPacingMs: 1500/);
  assert.match(worker, /String\(message\.country/);
  assert.match(worker, /String\(message\.language/);
  assert.match(panelHtml, /data-market="country" value="US"/);
  assert.match(hiAuto, /Quốc gia/);
});

monorepoTest('skip advances the queue and progress distinguishes Google from competitor scanning', () => {
  assert.match(panel, /skip: \(\) => send\(\{ type: 'COUPON_JOB_SKIP' \}\)/);
  assert.match(worker, /message\.type === 'COUPON_JOB_SKIP'/);
  assert.match(worker, /coupon\.driveQueue\(\)/);
  assert.match(worker, /Dự án đã có job trong hàng đợi/);
  assert.match(panel, /`Google \$\{job\.queries_run/);
  assert.match(panel, /`Nguồn \$\{Math\.min/);
  assert.match(hiAuto, /Đang tìm Google/);
});

test('running source exposes an immediate skip-page control without cancelling the project', () => {
  assert.match(panelHtml, /data-act="skip-current-source"[^>]*>Bỏ qua trang này/);
  assert.match(panel, /'skip-current-source': \(\) => send\(\{ type: 'COUPON_SOURCE_SKIP' \}\)/);
  assert.match(panel, /skipCurrentSource\.hidden = !currentSource\?\.url/);
  assert.match(worker, /coupon\.skipCurrentSource\(\)/);
});

test('coupon project picker loads independently and periodic refresh cannot overlap', () => {
  assert.match(worker, /message\.type === 'GET_COUPON_PROJECTS'/);
  assert.match(worker, /coupon-discovery\/projects\?limit=25&only=affiliate_fit&sort=third_party/);
  assert.doesNotMatch(worker.match(/message\.type === 'GET_HELPER_HANDSHAKE'[\s\S]*?message\.type === 'GET_COUPON_PROJECTS'/)?.[0] || '', /projects\?limit=25/);
  assert.match(panelHtml, /data-act="refresh-projects"/);
  assert.match(panel, /function loadCouponProjects/);
  assert.match(panel, /if \(refreshBusy\) return/);
});

test('side panel shows one selected task at a time and exposes Harvester as its own view', () => {
  assert.match(panelHtml, /data-project-picker open/);
  assert.match(panelHtml, /data-tools-drawer/);
  assert.match(panelHtml, /data-view="harvester">Bắt mã<\/button>/);
  assert.match(panelHtml, /<summary>Coupon Harvester<\/summary>/);
  assert.match(panel, /function renderPanelMode\(state\)/);
  assert.match(panel, /candidate\.status === 'discovered'/);
  assert.match(panel, /\$\('\[data-block="utilities"\]'\)\.hidden = view !== 'harvester'/);
  assert.match(panel, /\$\('\[data-tools-drawer\]'\)\.addEventListener\('toggle'/);
  assert.doesNotMatch(panel, /setInterval\(refresh, 2000\)/);
});
