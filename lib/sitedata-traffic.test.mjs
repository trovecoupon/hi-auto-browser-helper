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
const pasteScript = readFileSync(new URL('content/sitedata-search.js', root), 'utf8');
const autoSearchScript = readFileSync(new URL('content/sitedata-auto-search.js', root), 'utf8');

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

test('SiteData paste action fills the domain but never needs or clicks a Search button', async () => {
  class FakeInput {
    constructor() { this.disabled = false; this.placeholder = 'Enter a domain, e.g. chatgpt.com'; this.current = ''; }
    get value() { return this.current; }
    set value(value) { this.current = value; }
    getClientRects() { return [1]; }
    getAttribute(name) { return name === 'aria-label' ? '' : null; }
    scrollIntoView() {}
    focus() {}
    dispatchEvent() { return true; }
  }
  const input = new FakeInput();
  const result = await vm.runInNewContext(pasteScript, {
    document: { body: { innerText: 'Traffic Intelligence' }, readyState: 'complete',
      querySelectorAll: () => [input] },
    location: { href: 'https://sitedata.dev/', pathname: '/' },
    globalThis: { __HI_AUTO_TRAFFIC_DOMAIN__: 'example.com' },
    HTMLInputElement: FakeInput,
    InputEvent: class {}, Event: class {},
    getComputedStyle: () => ({ visibility: 'visible' }),
  });
  assert.equal(result.status, 'filled');
  assert.equal(result.reason, 'domain_filled_waiting_for_search');
  assert.equal(input.value, 'example.com');
});

test('Auto SiteData fills the real form and clicks Search exactly once', async () => {
  class FakeInput {
    constructor() { this.disabled = false; this.placeholder = 'Enter a domain'; this.current = ''; }
    get value() { return this.current; }
    set value(value) { this.current = value; }
    getClientRects() { return [1]; }
    getAttribute() { return ''; }
    scrollIntoView() {}
    focus() {}
    dispatchEvent() { return true; }
  }
  class FakeButton {
    constructor() { this.disabled = false; this.innerText = 'Analyze'; this.clicks = 0; }
    getClientRects() { return [1]; }
    getAttribute() { return ''; }
    scrollIntoView() {}
    focus() {}
    click() { this.clicks += 1; }
  }
  const input = new FakeInput();
  const button = new FakeButton();
  const state = { __HI_AUTO_TRAFFIC_DOMAIN__: 'example.com' };
  const context = {
    document: { body: { innerText: 'Website Traffic Checker' }, readyState: 'complete',
      querySelectorAll: (selector) => selector.startsWith('button') ? [button] : [input] },
    location: { href: 'https://sitedata.dev/', pathname: '/' }, globalThis: state,
    HTMLInputElement: FakeInput, InputEvent: class {}, Event: class {},
    getComputedStyle: () => ({ visibility: 'visible' }), setTimeout,
  };
  const first = await vm.runInNewContext(autoSearchScript, context);
  const second = await vm.runInNewContext(autoSearchScript, context);
  assert.equal(first.status, 'submitted');
  assert.equal(second.status, 'submitted');
  assert.equal(input.value, 'example.com');
  assert.equal(button.clicks, 1);
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

test('SiteData wiring has a direct host permission and an explicit Traffic panel', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  const panel = readFileSync(new URL('sidepanel/panel.html', root), 'utf8');
  const panelScript = readFileSync(new URL('sidepanel/panel.js', root), 'utf8');
  const worker = readFileSync(new URL('service-worker.js', root), 'utf8');
  const localBridge = readFileSync(new URL('content/local-app.js', root), 'utf8');
  const searchAdapter = readFileSync(new URL('content/sitedata-search.js', root), 'utf8');
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
  assert.match(worker, /openTrafficTab\(previous, job, searchUrl\)/);
  assert.match(worker, /waitForAutoSiteDataResult\(opened\.tab\.id, job\.provider_domain/);
  assert.match(worker, /traffic_last_result: completedResult/);
  assert.match(worker, /submitSiteDataSearch\(tab\.id, job\.provider_domain/);
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
  assert.match(worker, /chrome\.tabs\.create\(\{ url: searchUrl, active: true \}\)/);
  assert.doesNotMatch(worker, /chrome\.tabs\.create\(\{ url: resultUrl/);
  assert.match(worker, /maxJobs = TRAFFIC_BATCH_SIZE/);
  assert.doesNotMatch(worker, /await closeTrafficTab\(\);\s*\n\s*}\s*\n\s*return \{ completed/);
  assert.doesNotMatch(panel, /nghỉ <b>5–12 giây<\/b>/);
  assert.doesNotMatch(worker, /trafficPacingDelayMs/);
  assert.match(localBridge, /['"]\/api\/trend-gate\/traffic\/['"]/);
  assert.match(localBridge, /['"]\/api\/trend-gate\/traffic['"]/);
  assert.match(searchAdapter, /input\[placeholder\*="Enter a domain" i\]/);
  assert.match(searchAdapter, /Object\.getOwnPropertyDescriptor\(HTMLInputElement\.prototype, 'value'\)/);
  assert.match(searchAdapter, /new InputEvent\('input'/);
  assert.match(searchAdapter, /status: 'filled'/);
  assert.doesNotMatch(searchAdapter, /button\.click\(\)|new MouseEvent|pointerdown|mousedown|mouseup/);
  assert.match(script, /Monthly Visits/);
  assert.doesNotMatch(script, /traffic_block_missing/);
  assert.doesNotMatch(searchAdapter, /location\.(?:assign|replace)\s*\(|location\.href\s*=/);
  assert.match(autoSearchScript, /search\.click\(\)/);
  assert.match(worker, /TRAFFIC_AUTO_ALARM/);
  assert.match(worker, /traffic_tab_reopening/);
  assert.match(worker, /Number\.MAX_SAFE_INTEGER/);
});
