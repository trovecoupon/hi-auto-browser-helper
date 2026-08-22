import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  TRAFFIC_BATCH_SIZE, TRAFFIC_RATE_COOLDOWN_MS, isTrafficRateReason,
  trafficDomainDelayMs, trafficPollDelayMs, trafficWaitMs,
} from './sitedata-pacing.mjs';

const root = new URL('../', import.meta.url);
const script = readFileSync(new URL('content/sitedata-read.js', root), 'utf8');
const uiSearchScript = readFileSync(new URL('content/sitedata-ui-search.js', root), 'utf8');

// Khung giả lập cho CÁCH 2 (sitedataauto.js Cường verify 21/08): input React controlled
// + nút Search/Analyze; value phải đi qua native setter thì __reactProps mới được coi là nhận.
function uiSearchContext({ buttonText = 'Search', buttonDisabled = false, reactValue = 'example.com' } = {}) {
  class FakeInput {
    constructor() { this.current = ''; this.placeholder = 'Enter a domain, e.g. chatgpt.com'; }
    get value() { return this.current; }
    set value(value) { this.current = value; }
    dispatchEvent(event) { (this.events ||= []).push(event); return true; }
  }
  const input = new FakeInput();
  input.__reactProps$hi = { value: reactValue };
  const button = {
    textContent: buttonText, disabled: buttonDisabled, clicks: 0,
    click() { this.clicks += 1; },
  };
  const state = { __HI_AUTO_TRAFFIC_DOMAIN__: 'example.com' };
  return { input, button, state, context: {
    document: {
      body: { innerText: 'Website Traffic Checker' }, readyState: 'complete',
      querySelector: (selector) => (selector.includes('Enter a domain') ? input : input),
      querySelectorAll: () => [button],
    },
    location: { href: 'https://sitedata.dev/', pathname: '/' },
    globalThis: state,
    HTMLInputElement: FakeInput,
    Event: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    setTimeout,
  } };
}

test('UI fallback sets React value via native setter and clicks the enabled button once', async () => {
  const { input, button, context } = uiSearchContext();
  const first = await vm.runInNewContext(uiSearchScript, context);
  const second = await vm.runInNewContext(uiSearchScript, context);
  assert.equal(first.status, 'submitted');
  assert.equal(second.status, 'submitted');
  assert.equal(input.value, 'example.com');
  assert.equal(button.clicks, 1);
  assert.ok(input.events.some((event) => event.type === 'input' && event.bubbles));
});

test('UI fallback presses Enter when the button is disabled (same-domain result page)', async () => {
  const { input, button, context } = uiSearchContext({ buttonText: 'Analyze', buttonDisabled: true });
  const result = await vm.runInNewContext(uiSearchScript, context);
  assert.equal(result.status, 'submitted');
  assert.equal(button.clicks, 0);
  assert.ok(input.events.some((event) => event.type === 'keydown' && event.key === 'Enter'));
});

test('UI fallback stops when React state never receives the domain', async () => {
  const { button, context } = uiSearchContext({ reactValue: 'stale.com' });
  const result = await vm.runInNewContext(uiSearchScript, context);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'react_state_not_set');
  assert.equal(button.clicks, 0);
});

test('UI fallback reports the per-account rate limit marker as quota', async () => {
  const { context } = uiSearchContext();
  context.document.body.innerText = 'Rate limit exceeded — upgrade your plan.';
  const result = await vm.runInNewContext(uiSearchScript, context);
  assert.equal(result.status, 'quota');
  assert.equal(result.reason, 'rate_limited_or_quota');
});

function read(body, { domain = 'example.com', reads = 5, pathname = `/traffic/${domain}` } = {}) {
  return vm.runInNewContext(script, {
    document: { body: { innerText: body }, readyState: 'complete' },
    location: { href: `https://sitedata.dev${pathname}`, pathname },
    globalThis: { __HI_AUTO_TRAFFIC_DOMAIN__: domain, __HI_AUTO_TRAFFIC_READS__: reads },
  });
}

test('SiteData reader chooses the latest non-zero month and expands K/M units', () => {
  const result = read(`Traffic analytics for example.com\nVISITS OVER TIME\nJan 2026\n98.4K\nFeb 2026\n0\nMar 2026\n1.2M\nTRAFFIC SOURCES\nDirect`);
  assert.equal(result.status, 'ok');
  assert.equal(result.month, 'Mar 2026');
  assert.equal(result.monthly_visits, 1_200_000);
});

test('SiteData reader takes Monthly Visits immediately without waiting for the chart', () => {
  const result = read('Traffic analytics for example.com\nMonthly Visits\n83.2K\nVisits Over Time\nApr 2026\n70K\nMay 2026\n71K\nTraffic Sources');
  assert.equal(result.status, 'ok');
  assert.equal(result.month, 'latest');
  assert.equal(result.monthly_visits, 83_200);
});

test('a rate-limit banner cannot hide an already rendered Monthly Visits result', () => {
  const result = read('Website Traffic Checker for example.com\nrate limit\nMonthly Visits\n12.4K\nVisit Duration\n1m 34s');
  assert.equal(result.status, 'ok');
  assert.equal(result.monthly_visits, 12_400);
});

test('SiteData reader records an explicit Monthly Visits zero as a measured result', () => {
  const result = read('Website Traffic Checker for example.com\nMonthly Visits\n0\nVisit Duration\n0s');
  assert.equal(result.status, 'ok');
  assert.equal(result.monthly_visits, 0);
  assert.equal(result.month, 'latest');
});

test('SiteData reader records an all-zero chart as measured zero traffic', () => {
  const result = read('Traffic analytics for example.com\nVisits Over Time\nJan 2026\n0\nFeb 2026\n0\nTraffic Sources');
  assert.equal(result.status, 'ok');
  assert.equal(result.monthly_visits, 0);
  assert.equal(result.month, 'Feb 2026');
});

test('generic rate-limit help text is not treated as a live quota error', () => {
  const result = read('Website Traffic Checker for example.com\nRead about our rate limit and try again later guidance.');
  assert.equal(result.status, 'loading');
  assert.equal(result.reason, 'waiting_for_traffic_data');
});

test('a rendered SiteData shell stays loading instead of becoming guessed no-data', () => {
  const result = read('Website Traffic Checker for example.com\nTraffic analytics and site data are loading.\n'.repeat(30), { reads: 20 });
  assert.equal(result.status, 'loading');
  assert.equal(result.reason, 'waiting_for_traffic_data');
});

test('SiteData reader stops for a human challenge instead of skipping the domain', () => {
  const result = read('Just a moment… Verify you are human.');
  assert.equal(result.status, 'needs_user');
  assert.equal(result.reason, 'cloudflare');
});

test('SiteData reader stops the batch immediately when the site rate-limits requests', () => {
  const result = read('Error 429 — Too many requests. Try again later.');
  assert.equal(result.status, 'quota');
  assert.equal(result.reason, 'rate_limited');
});

test('SiteData reader reports a server outage instead of treating it as no data', () => {
  const result = read('503 Service Unavailable — please try again later.');
  assert.equal(result.status, 'needs_user');
  assert.equal(result.reason, 'sitedata_server_error');
});

test('SiteData home page is never mistaken for an empty traffic result after filling the form', () => {
  const result = read('Traffic Intelligence example.com Estimate domain traffic and audience signals.', {
    pathname: '/', reads: 10,
  });
  assert.equal(result.status, 'loading');
  assert.equal(result.reason, 'waiting_for_result_page');
});

test('SiteData uses one bounded batch and patient local DOM polling', () => {
  assert.equal(TRAFFIC_BATCH_SIZE, 8);
  assert.equal(trafficPollDelayMs(() => 0), 700);
  assert.ok(trafficPollDelayMs(() => 0.999999) <= 1200);
  assert.equal(trafficDomainDelayMs(() => 0), 40000);
  assert.ok(trafficDomainDelayMs(() => 0.999999) <= 50000);
  assert.equal(TRAFFIC_RATE_COOLDOWN_MS, 60 * 60 * 1000);
  assert.equal(trafficWaitMs(45000, 40000), 5000);
  assert.equal(trafficWaitMs(39000, 40000), 0);
  assert.equal(isTrafficRateReason('rate_limited'), true);
  assert.equal(isTrafficRateReason('quota_or_login'), false);
});

test('F39: auto-arm theo van tool — lan chet 7 ngay khong duoc tai dien', () => {
  const worker = readFileSync(new URL('service-worker.js', root), 'utf8');
  // watchdog phải hỏi shouldAutoArmTraffic khi công tắc local tắt (thay vì im lặng vĩnh viễn)
  assert.match(worker, /if \(!\(await trafficAutoEnabled\(\)\) && !\(await shouldAutoArmTraffic\(\)\)\) return false;/);
  // auto-arm chỉ khi: KHÔNG có cờ dừng tay + tool còn hàng + van tool mở (field machines)
  assert.match(worker, /traffic_operator_paused/);
  assert.match(worker, /if \(!remote \|\| !Number\(remote\.queued\)\) return false;/);
  assert.match(worker, /may\.coupon_sitedata === false && may\.brand_sitedata === false/);
  // tool cũ chưa trả machines → không tự bật (giữ hành vi cũ, không đoán)
  assert.match(worker, /if \(!may \|\|/);
  // Tạm dừng tay cắm cờ; Bật/Tiếp tục nhổ cờ
  assert.match(worker, /traffic_auto_enabled: false, traffic_operator_paused: true/);
  const nhoCo = worker.match(/chrome\.storage\.local\.remove\('traffic_operator_paused'\)/g) || [];
  assert.ok(nhoCo.length >= 2, 'RUN và RESUME đều phải nhổ cờ dừng tay');
  // Cường 22/08: đường AUTO chạy TAB NỀN như Trends/SimilarWeb — không cướp focus khi vét hàng
  assert.match(worker, /chrome\.tabs\.create\(\{ url: resultUrl, active: false \}\)/);
  const keoFocus = worker.match(/\{ url: resultUrl, active: true \}/g) || [];
  assert.equal(keoFocus.length, 1, 'chỉ lệnh tay "Mở lại" (REPASTE) được kéo tab lên trước');
  // Lệnh Cường 22/08 tối: sự cố phải HIỆN TRÊN UI TOOL — mỗi progress 'issue'/'cooldown' gửi
  // bản báo cáo về /traffic/helper/report (fire-and-forget, đặt SAU chốt khử trùng lặp).
  assert.match(worker, /stage === 'issue' \|\| stage === 'cooldown'/);
  assert.match(worker, /traffic\/helper\/report', \{ method: 'POST', body: progress \}\)\.catch/);
  // Pause do LỖI tự thử lại sau 5 phút — chỉ lệnh tay (traffic_operator_paused) treo được làn;
  // cấm hồi quy "một lỗi thoáng qua đứng vĩnh viễn tới khi có người gỡ tay".
  assert.match(worker, /Date\.now\(\) - mocLoi < 5 \* 60_000\) return false;/);
  assert.doesNotMatch(worker, /if \(saved\.traffic_paused\) return false;\s*\n\s*await api\('\/api\/trend-gate\/traffic\/queue'/);
});

test('SiteData wiring has a direct host permission and an explicit Traffic panel', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  const panel = readFileSync(new URL('sidepanel/panel.html', root), 'utf8');
  const panelScript = readFileSync(new URL('sidepanel/panel.js', root), 'utf8');
  const worker = readFileSync(new URL('service-worker.js', root), 'utf8');
  const localBridge = readFileSync(new URL('content/local-app.js', root), 'utf8');
  assert.ok(manifest.host_permissions.includes('https://sitedata.dev/*'));
  assert.match(panel, /data-view="traffic"/);
  assert.match(worker, /TRAFFIC_QUEUE_RUN/);
  assert.match(localBridge, /'TRAFFIC_QUEUE_RUN'/);
  assert.match(localBridge, /HELPER_COMMANDS\.has\(detail\.type\)/);
  assert.match(worker, /traffic_sitedata_next_allowed_at/);
  assert.match(worker, /traffic_sitedata_cooldown_until/);
  assert.match(worker, /traffic\/helper\/claim/);
  assert.match(panel, /data-traffic-feedback/);
  assert.match(panel, /data-traffic-last/);
  assert.match(panel, /data-act="traffic-paste"/);
  assert.match(panel, />Bật Auto SiteData<\/button>/);
  assert.match(panel, /data-act="traffic-pause"/);
  assert.match(panel, /data-act="traffic-resume"/);
  assert.match(panel, />Bỏ qua key này<\/button>/);
  assert.match(panel, /data-traffic-list/);
  assert.match(panelScript, /TRAFFIC_REASON_LABEL/);
  assert.match(panelScript, /progressAge >= 15/);
  assert.match(panelScript, /Đang bật Auto SiteData và chuẩn bị domain đầu tiên/);
  assert.match(panelScript, /TRAFFIC_ITEM_RETRY/);
  assert.match(panelScript, /TRAFFIC_ITEM_SKIP/);
  assert.match(worker, /Đã khôi phục lượt kiểm bị dở/);
  assert.match(worker, /queued\?\.traffic\?\.items\?\.find/);
  // Mở THẲNG /traffic/<domain> (CÁCH 1) — không điền form, không click nút nào trên SiteData.
  assert.match(worker, /openTrafficTab\(previous, job, resultUrl,\s*\(\) => waitForTrafficSlot\(job\)\)/);
  assert.doesNotMatch(worker, /submitSiteDataSearch|waitForAutoSiteDataResult|waitForManualSiteDataResult|fillSiteDataSearch/);
  assert.doesNotMatch(worker, /sitedata-search\.js|sitedata-auto-search\.js/);
  // Pacing đứng TRƯỚC điều hướng: chỉ openTrafficTab được tải trang kết quả, sau cổng beforeNavigate.
  assert.match(worker, /if \(beforeNavigate && !\(await beforeNavigate\(\)\)\)/);
  assert.match(worker, /if \(opened\.navigated\) await markTrafficSubmission\(\)/);
  // CÁCH 2 chỉ là dự phòng, và cũng phải qua cổng pacing trước khi search trên trang.
  assert.match(worker, /sitedata-ui-search\.js/);
  assert.match(worker, /UI_FALLBACK_REASONS\.has\(read\.reason\)\)\s*\{\s*if \(!\(await waitForTrafficSlot\(job\)\)\)/);
  assert.match(worker, /submitted\.status === 'submitted'/);
  assert.match(worker, /traffic_last_result: completedResult/);
  assert.match(worker, /message\.type === 'TRAFFIC_JOB_REPASTE'/);
  assert.match(worker, /message\.type === 'TRAFFIC_ITEM_RETRY'/);
  assert.match(worker, /message\.type === 'TRAFFIC_ITEM_SKIP'/);
  assert.match(worker, /traffic\?limit=25&lane=sitedata/);
  assert.match(worker, /item\.status === 'running' && item\.lane === 'sitedata'/);
  assert.match(worker, /traffic_job\?\.lane === 'sitedata'/);
  assert.match(worker, /traffic\/helper\/jobs\/\$\{trafficJobId\}\/retry/);
  assert.match(worker, /traffic\/helper\/jobs\/\$\{trafficJobId\}\/cancel/);
  assert.match(panelScript, /cancelled: 'đã bỏ'/);
  assert.match(worker, /trafficSkippedJobIds\.add/);
  assert.match(worker, /traffic_progress/);
  assert.match(worker, /function trafficDetailText/);
  assert.doesNotMatch(worker, /detail: detail \? String\(detail\)/);
  assert.doesNotMatch(worker, /chrome\.tabs\.create\(\{ url: searchUrl/);
  assert.match(worker, /maxJobs = TRAFFIC_BATCH_SIZE/);
  assert.doesNotMatch(worker, /await closeTrafficTab\(\);\s*\n\s*}\s*\n\s*return \{ completed/);
  assert.doesNotMatch(panel, /nghỉ <b>5–12 giây<\/b>/);
  assert.doesNotMatch(worker, /trafficPacingDelayMs/);
  assert.match(localBridge, /['"]\/api\/trend-gate\/traffic\/['"]/);
  assert.match(localBridge, /['"]\/api\/trend-gate\/traffic['"]/);
  assert.match(script, /Monthly Visits/);
  assert.doesNotMatch(script, /traffic_block_missing/);
  assert.match(worker, /TRAFFIC_AUTO_ALARM/);
  assert.match(worker, /traffic_tab_reopening/);
  assert.match(worker, /Number\.MAX_SAFE_INTEGER/);
});
