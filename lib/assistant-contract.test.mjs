import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { base64Bytes, deepQueryAll, isForecastEntryLabel, shouldReusePlannerTab } from './keyword-planner.mjs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));
const worker = fs.readFileSync(new URL('service-worker.js', root), 'utf8');
const form = fs.readFileSync(new URL('lib/form-assistant.mjs', root), 'utf8');
const localBridge = fs.readFileSync(new URL('content/local-app.js', root), 'utf8');
const sharedContent = fs.readFileSync(new URL('content/shared.js', root), 'utf8');
const panel = fs.readFileSync(new URL('sidepanel/panel.html', root), 'utf8');
const panelScript = fs.readFileSync(new URL('sidepanel/panel.js', root), 'utf8');
const adsSerp = fs.readFileSync(new URL('content/serp.js', root), 'utf8');
const keywordPlannerContent = fs.readFileSync(new URL('content/keyword-planner.js', root), 'utf8');
const affiliateContent = fs.readFileSync(new URL('content/affiliate-form.js', root), 'utf8');
const googleAdFrame = fs.readFileSync(new URL('content/google-ad-frame.js', root), 'utf8');
const adsTransparencyContent = fs.readFileSync(new URL('content/ads-transparency.js', root), 'utf8');
const ocrWorker = fs.readFileSync(new URL('offscreen/ocr.js', root), 'utf8');

test('Keyword Planner has upload, download tracking, and result sync wiring', () => {
  assert.ok(manifest.permissions.includes('downloads'));
  assert.ok(manifest.host_permissions.includes('https://ads.google.com/*'));
  assert.match(worker, /START_KEYWORD_PLANNER/);
  assert.match(worker, /downloads\.onChanged/);
  assert.match(worker, /\/api\/demand\/helper\/jobs\/\$\{command\.job_id\}\/complete/);
  assert.deepEqual([...base64Bytes(btoa('Keyword\r\nhello'))], [...new TextEncoder().encode('Keyword\r\nhello')]);
  assert.equal(shouldReusePlannerTab('https://ads.google.com/aw/keywordplanner/plan/keywords', true), true);
  assert.equal(shouldReusePlannerTab('https://ads.google.com/aw/keywordplanner/home', false), false);
  assert.equal(shouldReusePlannerTab('https://accounts.google.com/signin', true), false);
  assert.match(worker, /RESUME_KEYWORD_PLANNER/);
  assert.doesNotMatch(panel, /data-block="keyword-planner"/);
  assert.doesNotMatch(panelScript, /function renderKeywordPlanner/);
  assert.equal(isForecastEntryLabel('Nhận thông tin dự đoán và lượng tìm kiếm'), true);
  assert.equal(isForecastEntryLabel('Get search volume and forecasts'), true);
  assert.equal(isForecastEntryLabel('Khám phá các từ khóa mới'), false);
  assert.match(keywordPlannerContent, /opening_forecast_upload/);
  assert.match(keywordPlannerContent, /findForecastEntry/);
  assert.match(worker, /job_id: resumeHeld \? previous\.keyword_planner_command\?\.job_id/);
  assert.match(worker, /hasOpenJob/);
  assert.match(worker, /Đã nối lại batch Keyword Planner đang dở/);
  assert.match(worker, /files: \['content\/keyword-planner\.js'\]/);
  assert.match(keywordPlannerContent, /__HI_AUTO_KEYWORD_PLANNER_CONTENT__/);
  const nestedFile = { id: 'nested-file' };
  const shadow = { querySelectorAll: (selector) => selector === 'input[type="file"]' ? [nestedFile] : [] };
  const host = { shadowRoot: shadow };
  const fakeRoot = { querySelectorAll: (selector) => selector === '*' ? [host] : [] };
  assert.deepEqual(deepQueryAll(fakeRoot, 'input[type="file"]'), [nestedFile]);
  assert.match(panel, /data-block="coupon-control"/);
  assert.match(panelScript, /renderPanelMode\(state\)/);
});

test('Ads image projects use local OCR and preserve the real landing destination', () => {
  assert.match(googleAdFrame, /landing_url: destinationUrl\(\)/);
  assert.match(googleAdFrame, /image_urls: originalImageUrls/);
  assert.match(googleAdFrame, /\['adurl', 'url', 'q', 'dest', 'destination', 'redirect'\]/);
  assert.match(worker, /PORTFOLIO_OCR_BATCH_START/);
  assert.match(worker, /PORTFOLIO_OCR_BATCH_STATUS/);
  assert.match(worker, /creative-ocr\/jobs/);
  assert.match(worker, /refreshAdsTransparencyContentScripts/);
  assert.match(sharedContent, /dataset\.helperVersion/);
  assert.match(adsTransparencyContent, /1\/3 · Đang tải toàn bộ ảnh về máy/);
  assert.match(adsTransparencyContent, /2\/3 · Tesseract đang OCR file local/);
  assert.match(adsTransparencyContent, /skipped_creative_ids/);
  assert.match(adsTransparencyContent, /usableCreatives/);
  assert.doesNotMatch(adsTransparencyContent, /if \(ocr\.without_assets > 0\)/);
  assert.match(worker, /source_catcher_id: helperContext\.selected_source_domain_id/);
  assert.match(adsTransparencyContent, /source_catcher_id: sourceCatcherId/);
  assert.match(panel, /data-ads-ocr/);
  assert.match(panelScript, /renderAdsOcr/);
  assert.doesNotMatch(worker, /manualCreatives[\s\S]{0,300}\.slice\(0, 200\)/);
  assert.match(ocrWorker, /ocr_mode === 'creative-original'/);
  assert.match(ocrWorker, /source: 'original_asset'/);
  assert.match(ocrWorker, /prepareOriginalImage/);
  assert.match(ocrWorker, /\['6', '11'\]/);
  assert.match(ocrWorker, /worker_attempt: workerAttempt/);
});

test('Affiliate form wiring requests per-origin permission and never submits', () => {
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.match(worker, /REQUEST_AFFILIATE_PERMISSION/);
  assert.match(worker, /APPLY_AFFILIATE_SAFE_FIELDS/);
  assert.match(worker, /MARK_AFFILIATE_SUBMITTED/);
  assert.doesNotMatch(form, /\.submit\s*\(/);
  assert.match(form, /password\|passcode\|otp/);
  assert.match(form, /legal\|terms\|consent/);
});

test('Affiliate Auto Fill learns every visible field and keeps passwords extension-local', () => {
  assert.match(affiliateContent, /new MutationObserver/);
  assert.match(affiliateContent, /host\.shadowRoot/);
  assert.match(affiliateContent, /nextFingerprint !== lastFingerprint/);
  assert.match(panelScript, /const learnableFields = \[\.\.\.missingFields, \.\.\.passwordPrompts\]/);
  assert.match(panelScript, /LEARN_AFFILIATE_LOCAL_SECRET/);
  assert.match(panelScript, /answer\.type = 'password'/);
  assert.match(worker, /AFFILIATE_LOCAL_SECRETS_KEY = 'affiliate_local_secrets_v1'/);
  assert.match(worker, /setAccessLevel\?\.\(\{ accessLevel: 'TRUSTED_CONTEXTS' \}\)/);
  assert.match(worker, /locally_managed_secret: true/);
  assert.match(form, /item\.locally_managed_secret === true/);
  assert.match(form, /function deepFormControls/);
  assert.match(form, /function findScannedField/);
  assert.match(worker, /auto_fill_plan: autoFill \? runtimePlan : null/);
  assert.match(form, /manual_override/);
  assert.match(form, /existing_value/);
  assert.match(form, /event\.isTrusted/);
  assert.match(affiliateContent, /autoFilledSteps/);
});

test('Hi Auto bridge uses the public app and pairs Browser Helper through Local Agent', () => {
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1:8770/*'));
  assert.ok(manifest.host_permissions.includes('http://localhost:8770/*'));
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1:8771/*'));
  assert.ok(manifest.host_permissions.includes('https://hi-auto.vercel.app/*'));
  assert.ok(!JSON.stringify(manifest).includes('tail49c59d'));
  assert.match(worker, /rehydrateHiAutoBridges\(\)\.catch/);
  assert.match(worker, /REPAIR_HI_AUTO_CONNECTION/);
  assert.match(worker, /PAIR_LOCAL_AGENT/);
  assert.match(worker, /pairWithAgent/);
  assert.match(localBridge, /__HI_AUTO_BROWSER_HELPER_BRIDGE__/);
  assert.match(localBridge, /REQUEST_HELPER_PAIRING/);
  assert.match(panel, /data-act="repair-connection"/);
  assert.match(panel, /data-act="pair-agent"/);
});

test('expired pairing is renewed once in background without stealing the coupon tab', () => {
  assert.match(worker, /repairLegacyHiAutoConnection\(\{ activate: false \}\)/);
  assert.match(worker, /pairing_invalid/);
  assert.match(worker, /Date\.now\(\) >= expiresAt - 60_000/);
});

test('Ads SERP is fail-closed and only runs in an explicitly owned Ads Discovery tab', () => {
  const guard = adsSerp.indexOf("type: 'GET_GOOGLE_SERP_MODE'");
  const overlay = adsSerp.indexOf("ui.mount('Discovery · Google SERP')");
  const legacyApi = adsSerp.indexOf("type: 'GET_DISCOVERY_JOB'");
  assert.ok(guard >= 0 && guard < overlay && guard < legacyApi);
  assert.match(adsSerp, /context\?\.mode !== 'ads_discovery'\) return/);
  assert.match(adsSerp, /catch \{ return; \}/);
  assert.match(worker, /googleSerpMode\(await savedState\(\), sender\.tab\)/);
  assert.match(googleAdFrame, /mode\?\.mode !== 'ads_discovery'\) return/);
});

test('Hi Auto relay uses the backend CSRF header for write requests', () => {
  assert.match(localBridge, /const HI_AUTO_CSRF_HEADER = ['"]X-Coupon-Tool-CSRF['"]/);
  assert.match(localBridge, /headers\[HI_AUTO_CSRF_HEADER\] = relayCsrf/);
  assert.doesNotMatch(localBridge, /headers\[['"]X-CSRF-Token['"]\]/);
});

test('permission-held coupon jobs expose a one-click grant and resume action', () => {
  assert.match(panelScript, /errorCode === ['"]PERMISSION_MISSING['"]/);
  assert.match(panelScript, /Cấp quyền và tự lấy mã/);
  assert.match(panelScript, /chrome\.permissions\.request\(\{ origins: pendingPermissionOrigins \}\)/);
  assert.match(panelScript, /chrome\.permissions\.contains\(\{ origins: pendingPermissionOrigins \}\)/);
  assert.match(panelScript, /type: ['"]COUPON_JOB_RESUME['"]/);
});

test('affiliate form can save a newly seen answer into the selected profile', () => {
  assert.match(worker, /message\.type === 'LEARN_AFFILIATE_ANSWER'/);
  assert.match(worker, /\/learn-answer/);
  assert.match(panelScript, /Lưu vào hồ sơ & dùng ngay/);
  assert.match(panelScript, /type: 'LEARN_AFFILIATE_ANSWER'/);
  assert.match(panelScript, /scope: 'global'/);
  assert.match(worker, /report: false/);
  assert.match(worker, /Đã học câu trả lời, lưu vào hồ sơ và điền ngay trên form/);
});

test('affiliate task starts at Google, follows the selected link, then chooses profile in the panel', () => {
  assert.match(localBridge, /browser-helper-affiliate-search/);
  assert.match(worker, /START_AFFILIATE_SEARCH/);
  assert.match(worker, /START_AFFILIATE_FROM_SEARCH/);
  assert.match(worker, /affiliate_search_session/);
  assert.match(worker, /chrome\.tabs\.create\(\{ url: 'about:blank'/);
  assert.match(worker, /chrome\.tabs\.update\(tab\.id, \{ url: searchUrl\.href/);
  assert.match(worker, /\{ windowId: sender\.tab\.windowId \}/);
  assert.match(worker, /affiliate-helper\/profiles/);
  assert.match(panel, /NHIỆM VỤ HIỆN TẠI/);
  assert.match(panel, /data-aff-profile/);
  assert.match(panel, /Quét & điền form này/);
  assert.match(panelScript, /chrome\.permissions\.request\(\{ origins \}\)/);
  assert.match(affiliateContent, /auto_fill_plan/);
});

test('Ads OCR domain verification stays manual on Google then automatically queues traffic', () => {
  assert.match(localBridge, /browser-helper-domain-verification/);
  assert.match(worker, /START_DOMAIN_VERIFICATION/);
  assert.match(worker, /purpose: 'domain_verification'/);
  assert.match(worker, /finishDomainVerification/);
  assert.match(worker, /verify-domain/);
  assert.match(worker, /pipeline_stage === 'traffic_queued'/);
  assert.match(panel, /data-domain-verify/);
  assert.match(panelScript, /không tự chọn kết quả/);
  assert.match(panelScript, /RETRY_DOMAIN_VERIFICATION/);
});

test('affiliate popup forms are prioritized across modals, frames and same-job popup tabs', () => {
  const formAssistant = fs.readFileSync(new URL('lib/form-assistant.mjs', root), 'utf8');
  assert.match(formAssistant, /popupSurface/);
  assert.match(formAssistant, /frame\.contentDocument/);
  assert.match(formAssistant, /popup_frame_origins/);
  assert.match(worker, /allFrames: true/);
  assert.match(worker, /affiliate_application_frame_id/);
  assert.match(worker, /adoptAffiliatePopupTab/);
  assert.match(worker, /GRANT_AFFILIATE_POPUP_ACCESS/);
  assert.match(panel, /grant-affiliate-popup/);
  assert.match(panelScript, /Cấp quyền và quét popup/);
});

test('Side Panel exposes every supported module and loads data only for the selected task', () => {
  for (const view of ['overview', 'ads', 'coupon', 'affiliate', 'harvester']) {
    assert.match(panel, new RegExp(`data-view="${view}"`));
  }
  assert.match(panel, /Kiểm cầu \(KP\)/);
  assert.match(localBridge, /browser-helper-set-context/);
  assert.match(worker, /message\.type === 'SET_HELPER_CONTEXT'/);
  assert.match(worker, /initialView === 'coupon'\s*\? await coupon\.currentState\(\)/);
  assert.match(panelScript, /state\.helper_view/);
  assert.doesNotMatch(panelScript, /refresh\(\);\s*loadCouponProjects\(\)/);
});

test('affiliate assistance is non-blocking and Google ad frames tolerate a missing display URL', () => {
  assert.match(googleAdFrame, /display \? display\.split/);
  assert.doesNotMatch(googleAdFrame, /const parts = display\.split/);
  assert.match(panel, /Cần học/);
  assert.match(panel, /Không tự điền/);
  assert.match(panelScript, /Đây không phải lỗi và không làm dừng Helper/);
  assert.match(panelScript, /content_assist/);
});

test('old content worlds stop quietly when an extension reload invalidates their context', () => {
  assert.match(localBridge, /if \(!chrome\.runtime\?\.id\) return/);
  assert.match(localBridge, /extension context invalidated/i);
  assert.match(localBridge, /pending\?\.catch\?/);
  assert.match(sharedContent, /try \{\s*if \(!runtime\?\.id\)/);
  assert.match(googleAdFrame, /\}\)\(\)\.catch/);
  assert.match(googleAdFrame, /extension context invalidated/i);
});

test('professional extension icon set is declared and present', () => {
  for (const size of [16, 32, 48, 128]) {
    assert.equal(manifest.icons[String(size)], `assets/icon-${size}.png`);
    assert.ok(fs.statSync(new URL(`assets/icon-${size}.png`, root)).size > 100);
  }
});
