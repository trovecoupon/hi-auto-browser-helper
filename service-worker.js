import { FrameSnapshotCache, validateFrameSnapshotMessage } from './lib/frame-coordinator.mjs';
import {
  HELPER_VERSION, adsTransparencyDomainUrl, allowedNavigation, canCloseOwnedTab,
  canonicalAdvertiserProfileUrl, claimSerpTab,
  createOwnedTabRegistry, ownedTemporaryTabIds, registerCreatedTab,
  googleSerpMode, helperPanelView, serpRegistrationDecision, validateAdvertiserProfile, validateJobIdentity, withAnywhereRegion,
  matchesAdsTransparencyDomainFilter,
} from './lib/job-orchestrator.mjs';
import { buildHandshake, createRegistry } from './lib/adapter-registry.mjs';
import { COUPON_STATE_KEYS, createOrchestrator } from './lib/coupon-orchestrator.mjs';
import { createHarvesterRuntime } from './lib/coupon-harvester-runtime.mjs';
import { shouldReusePlannerTab } from './lib/keyword-planner.mjs';
import {
  affiliateTabMatches, chooseAffiliateRecoveryTab, recoverableAffiliateJob, recoveredAffiliateState,
} from './lib/affiliate-recovery.mjs';
import {
  TRAFFIC_BATCH_SIZE, TRAFFIC_RATE_COOLDOWN_MS, isTrafficRateReason,
  trafficDomainDelayMs, trafficPollDelayMs, trafficWaitMs,
} from './lib/sitedata-pacing.mjs';
import {
  AGENT_BRIDGE_URL, agentSessionState, bridgeHealth, claimAgentJob, completeAgentJob,
  localApiViaAgent, pairWithAgent,
} from './lib/agent-bridge.mjs';

import {
  UPDATE_ALARM, UPDATE_CHECK_MINUTES, checkForUpdate, enablePanelForTab,
} from './lib/hi-auto-autostart.mjs';

import {
  OFFLINE_ANSWERS_KEY, buildOfflinePlan, harvestAnswers, mergeAnswers,
} from './lib/offline-fill.mjs';

const TRAFFIC_AUTO_ALARM = 'hi-auto-sitedata-watchdog';
const AGENT_JOB_ALARM = 'hi-auto-agent-job-watchdog';
const TRAFFIC_NEXT_ALLOWED_KEY = 'traffic_sitedata_next_allowed_at';
const TRAFFIC_COOLDOWN_KEY = 'traffic_sitedata_cooldown_until';

const frameCache = new FrameSnapshotCache();
const inFlightWrites = new Map();
const domainVerificationInFlight = new Set();
const affiliateInjectedTabs = new Set();
const ADS_TRANSPARENCY_ROOT = withAnywhereRegion('https://adstransparency.google.com/');
const ADVERTISER_PROFILE_DELAY_MS = 2500;
const ADVERTISER_DOMAIN_DELAY_MS = 5000;
const HI_AUTO_TAB_PATTERNS = [
  'http://127.0.0.1:8770/*', 'http://localhost:8770/*',
  'https://hi-auto.vercel.app/*',
];
const isHiAutoUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'https:' && url.hostname === 'hi-auto.vercel.app') return true;
    return url.protocol === 'http:' && url.port === '8770'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
};

async function agentSavedState() {
  const value = await chrome.storage.local.get([
    'agent_helper_token', 'agent_helper_expires_at', 'agent_helper_session_id',
  ]);
  return {
    helper_token: value.agent_helper_token || '',
    expires_at: value.agent_helper_expires_at || '',
    session_id: value.agent_helper_session_id || '',
  };
}

async function agentConnectionState({ checkHealth = false } = {}) {
  const session = await agentSavedState();
  const state = agentSessionState(session);
  if (state !== 'connected' || !checkHealth) return state;
  try { await bridgeHealth(); return 'connected'; } catch { return 'offline'; }
}

async function pairAgent(code) {
  await bridgeHealth();
  const grant = await pairWithAgent(code);
  await chrome.storage.local.set({
    agent_helper_token: grant.helper_token,
    agent_helper_expires_at: grant.expires_at,
    agent_helper_session_id: grant.session_id,
  });
  await installAgentJobWatchdog();
  notifyPanel({ kind: 'agent', log: 'Đã ghép Browser Helper với Local Agent.', level: 'ok' });
  return { agent: { state: 'connected', bridge_url: AGENT_BRIDGE_URL, expires_at: grant.expires_at },
    message: 'Đã kết nối Local Agent.' };
}

async function repairHiAutoConnection() {
  await bridgeHealth();
  const state = await agentConnectionState();
  if (state === 'connected') {
    await installAgentJobWatchdog();
    const tabs = await chrome.tabs.query({ url: HI_AUTO_TAB_PATTERNS });
    if (tabs.length) await repairLegacyHiAutoConnection({ activate: false }).catch(() => null);
    return { agent: { state, bridge_url: AGENT_BRIDGE_URL }, message: 'Local Agent đang hoạt động.' };
  }
  throw new Error('Local Agent đang chạy nhưng Extension chưa ghép. Tạo mã trên Hi Auto Cloud rồi nhập 6 số tại đây.');
}

async function executeAgentJob(job) {
  const operation = String(job?.payload?.operation || 'ping');
  if (operation === 'ping') return { pong: true, extension_version: HELPER_VERSION };
  if (operation === 'open_url') {
    const url = new URL(String(job?.payload?.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL job phải dùng HTTP hoặc HTTPS.');
    const tab = await chrome.tabs.create({ url: url.href, active: job?.payload?.active !== false });
    return { opened: true, tab_id: tab.id, url: url.href };
  }
  if (operation === 'set_helper_context') {
    const mode = String(job?.payload?.mode || 'overview');
    if (!['overview', 'ads', 'traffic', 'coupon', 'affiliate', 'harvester'].includes(mode)) {
      throw new Error('Helper context từ cloud không hợp lệ.');
    }
    const context = { mode, route: '', label: String(job?.payload?.label || '').slice(0, 100),
      source: 'cloud_agent', updated_at: Date.now() };
    await chrome.storage.session.set({ helper_context: context });
    notifyPanel({ kind: 'context' });
    return { context };
  }
  const error = new Error(`Extension chưa hỗ trợ operation ${operation}.`);
  error.code = 'EXTENSION_OPERATION_UNSUPPORTED';
  throw error;
}

let agentJobPoll = null;
async function pollAgentJob() {
  if (agentJobPoll) return agentJobPoll;
  agentJobPoll = (async () => {
    const session = await agentSavedState();
    // Có token thì CỨ THỬ — server giữ phiên trượt (dùng là tự gia hạn) nên đồng hồ cục bộ
    // không được phép khai tử phiên; chỉ server trả pairing_invalid mới xoá token thật.
    if (!session.helper_token) return null;
    let job;
    try { job = (await claimAgentJob(session.helper_token)).job; }
    catch (error) {
      if (['pairing_invalid', 'pairing_required'].includes(error.code)) {
        await chrome.storage.local.remove(['agent_helper_token', 'agent_helper_expires_at', 'agent_helper_session_id']);
        notifyPanel({ kind: 'agent', log: 'Phiên Local Agent đã hết hạn; hãy ghép lại bằng mã 6 số.', level: 'error' });
      }
      return null;
    }
    if (!job) return null;
    try {
      const result = await executeAgentJob(job);
      await completeAgentJob(job.local_job_id, session.helper_token, { status: 'succeeded', result });
      notifyPanel({ kind: 'agent', log: `Đã hoàn tất job ${job.job_type}.`, level: 'ok' });
      return result;
    } catch (error) {
      await completeAgentJob(job.local_job_id, session.helper_token, {
        status: 'failed', result: {}, error_code: error.code || 'EXTENSION_JOB_FAILED',
        error_detail: String(error.message || error).slice(0, 300),
      }).catch(() => null);
      notifyPanel({ kind: 'agent', log: String(error.message || error), level: 'error' });
      return null;
    }
  })().finally(() => { agentJobPoll = null; });
  return agentJobPoll;
}

async function installAgentJobWatchdog() {
  await chrome.alarms.create(AGENT_JOB_ALARM, { periodInMinutes: 0.5 });
  pollAgentJob().catch(() => {});
}

function sanitizeAdvertiserProfiles(items, limit = 50) {
  const profiles = [];
  for (const item of Array.isArray(items) ? items : []) {
    const advertiserId = String(item?.advertiser_id || '');
    const profileUrl = canonicalAdvertiserProfileUrl(item?.profile_url, advertiserId);
    if (!validateAdvertiserProfile(profileUrl, advertiserId)
        || profiles.some((profile) => profile.advertiser_id === advertiserId)) continue;
    profiles.push({
      advertiser_id: advertiserId,
      profile_url: profileUrl,
      advertiser_name: String(item?.advertiser_name || '').slice(0, 300) || null,
      evidence: String(item?.evidence || '').slice(0, 4000) || null,
    });
    if (profiles.length >= limit) break;
  }
  return profiles;
}

async function injectHiAutoBridge(tabId) {
  if (!Number.isInteger(Number(tabId))) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, files: ['content/local-app.js'] });
    return true;
  } catch { return false; }
}

async function rehydrateHiAutoBridges() {
  const tabs = await chrome.tabs.query({ url: HI_AUTO_TAB_PATTERNS });
  await Promise.all(tabs.map((tab) => injectHiAutoBridge(tab.id)));
  return tabs.filter((tab) => Number.isInteger(tab.id));
}

async function refreshAdsTransparencyContentScripts() {
  const tabs = await chrome.tabs.query({ url: ['https://adstransparency.google.com/*'] });
  await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id)).map(async (tab) => {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true },
      files: ['content/google-ad-frame.js'] }).catch(() => null);
    await chrome.scripting.executeScript({ target: { tabId: tab.id },
      files: ['content/ads-transparency.js'] }).catch(() => null);
  }));
}

async function repairLegacyHiAutoConnection({ activate = true } = {}) {
  const tabs = await rehydrateHiAutoBridges();
  if (!tabs.length) {
    const tab = await chrome.tabs.create({ url: 'http://127.0.0.1:8770/', active: true });
    return { message: 'Đã mở Hi Auto. Chờ trang tải xong rồi bấm “Kết nối lại” thêm một lần.', tab_id: tab.id };
  }
  const target = tabs.find((tab) => tab.active) || tabs[0];
  if (activate) await chrome.tabs.update(target.id, { active: true });
  const requested = await chrome.tabs.sendMessage(target.id, { type: 'REQUEST_HELPER_PAIRING' })
    .catch(() => null);
  if (!requested?.ok) throw new Error('Không kích hoạt được cầu nối trong tab Hi Auto. Hãy Ctrl+F5 tab đó rồi thử lại.');
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const state = await savedState();
    if (state.local_tab_id === target.id && state.helper_token
        && Date.now() < Date.parse(state.helper_expires_at || 0)) {
      return { message: 'Đã kết nối lại Hi Auto thành công.', tab_id: target.id };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Tab Hi Auto đã nhận yêu cầu nhưng chưa cấp pairing. Hãy đăng nhập lại Hi Auto rồi thử lại.');
}

let pairingRepair = null;
async function renewHelperPairing() {
  if (!pairingRepair) {
    pairingRepair = (async () => {
      const agent = await agentSavedState();
      if (agentSessionState(agent) === 'connected') {
        const issued = await localApiViaAgent('/api/ads-miner/browser-helper/pair',
          agent.helper_token, { method: 'POST', body: {} });
        await chrome.storage.session.set({
          helper_token: issued.pairing_token, helper_expires_at: issued.expires_at,
          session_id: issued.session_id,
        });
        return { message: 'Đã tự gia hạn qua Local Agent.' };
      }
      return repairLegacyHiAutoConnection({ activate: false });
    })()
      .finally(() => { pairingRepair = null; });
  }
  return pairingRepair;
}

// Service worker có thể khởi động sau khi extension unpacked vừa được Reload trong khi tab Hi Auto vẫn mở.
// Bơm lại bridge ngay ở mỗi vòng đời worker để cú click tiếp theo không phụ thuộc vào việc người dùng nhớ Ctrl+F5.
rehydrateHiAutoBridges().catch(() => {});
installAgentJobWatchdog().catch(() => {});
// Profile passwords are persisted only inside the extension. They are delivered ephemerally to the isolated
// fill script, but never stored in session plans or sent to Hi Auto APIs, AI, logs, exports, or the handshake.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
// Keyword Planner đã chuyển sang CSV thủ công: bỏ executor cục bộ cũ nhưng không đóng tab Google Ads.
chrome.storage.session.remove([
  'keyword_planner_command', 'keyword_planner_tab_id', 'keyword_planner_download_id',
]).catch(() => {});

async function savedState() {
  return chrome.storage.session.get([
    'helper_token', 'helper_expires_at', 'session_id', 'local_tab_id',
    'active_job', 'work_tab_id', 'tab_registry', 'portfolio_command',
    'catcher_research_command', 'advertiser_command', 'serp_registration',
    'keyword_planner_command', 'keyword_planner_tab_id', 'keyword_planner_download_id',
    'affiliate_search_session', 'affiliate_search_root_tab_id', 'affiliate_search_tab_id',
    'affiliate_auto_fill_pending', 'offline_fill_tab_id',
    'affiliate_application_command', 'affiliate_application_tab_id', 'affiliate_application_frame_id',
    'affiliate_application_frame_score', 'affiliate_application_frame_seen_at',
    'affiliate_popup_allowed_origins', 'affiliate_popup_candidate_tab_id', 'affiliate_fill_plan',
    'affiliate_ai_suggestions',
    'helper_context', 'portfolio_ocr_job',
    'traffic_job', 'traffic_tab_id', 'traffic_paused', 'traffic_last_result',
    'traffic_next_allowed_at', 'traffic_progress',
    'coupon_harvester_active_tabs',
    ...COUPON_STATE_KEYS,
  ]);
}

const AFFILIATE_LOCAL_SECRETS_KEY = 'affiliate_local_secrets_v1';
const DEFAULT_AFFILIATE_PASSWORDS = Object.freeze(['TroveCoupon2026!', 'TroveCoupon2026']);

async function affiliateLocalPassword(profileId) {
  const id = String(Number(profileId) || '');
  if (!id) return '';
  const stored = await chrome.storage.local.get(AFFILIATE_LOCAL_SECRETS_KEY);
  return String(stored[AFFILIATE_LOCAL_SECRETS_KEY]?.[id]?.password || '');
}

function affiliatePasswordTargets(plan) {
  return (plan?.blocked || []).filter((item) => item.local_secret_kind === 'password' && item.dom_id);
}

async function markAffiliateLocalSecrets(plan, command) {
  if (!plan) return plan;
  // Điểm hội tụ của MỌI plan online → chỗ duy nhất cần học cho chế độ điền offline.
  rememberOfflineAnswers(plan, command?.scan).catch(() => {});
  const hasPassword = Boolean(await affiliateLocalPassword(command?.profile_id));
  return { ...plan, blocked: (plan.blocked || []).map((item) => item.local_secret_kind === 'password'
    ? { ...item, has_local_value: true, has_custom_password: hasPassword,
      password_automatic: true } : item) };
}

// ── Điền form OFFLINE: học từ plan online, điền lại khi tool/Agent tắt ────────
async function rememberOfflineAnswers(plan, scan) {
  const entries = harvestAnswers(plan, scan);
  if (!entries.length) return;
  const stored = await chrome.storage.local.get(OFFLINE_ANSWERS_KEY);
  const merged = mergeAnswers(stored[OFFLINE_ANSWERS_KEY] || [], entries);
  await chrome.storage.local.set({ [OFFLINE_ANSWERS_KEY]: merged });
}

async function offlineScanResponse(scan) {
  const stored = await chrome.storage.local.get(OFFLINE_ANSWERS_KEY);
  const plan = buildOfflinePlan(scan, stored[OFFLINE_ANSWERS_KEY] || []);
  const total = (stored[OFFLINE_ANSWERS_KEY] || []).length;
  notifyPanel({ kind: 'affiliate', level: plan.fields.length ? 'ok' : 'warn',
    log: plan.fields.length
      ? `Điền offline: nhận ra ${plan.fields.length} trường từ hồ sơ đã học (${total} mục).`
      : `Điền offline: form này chưa khớp trường nào trong hồ sơ đã học (${total} mục).` });
  return {
    message: plan.fields.length
      ? `Đang điền offline ${plan.fields.length} trường. Mật khẩu/điều khoản/Submit vẫn do bạn xử lý.`
      : 'Chưa khớp trường nào — hãy chạy một lượt điền online để Helper học thêm.',
    plan, auto_fill_plan: plan.fields.length ? plan : null, offline: true,
  };
}

const OFFLINE_FILLABLE_URL = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !isHiAutoUrl(url.href)
      && !/(?:^|\.)google\.com$/i.test(url.hostname);
  } catch { return false; }
};

async function affiliateRuntimePlan(plan, command) {
  const password = await affiliateLocalPassword(command?.profile_id);
  const candidates = [...new Set([password, ...DEFAULT_AFFILIATE_PASSWORDS].filter(Boolean))];
  const secretFields = affiliatePasswordTargets(plan).map((item) => ({
    dom_id: item.dom_id,
    field_key: item.password_confirmation ? 'local_password_confirmation' : 'local_password',
    value: candidates[0],
    value_candidates: candidates,
    local_secret_group: `affiliate_password_${Number(command?.profile_id) || 0}`,
    sensitive: true,
    confirmed_sensitive: true,
    locally_managed_secret: true,
  }));
  return { ...plan, fields: [...(plan?.fields || []), ...secretFields] };
}

async function saveAffiliateLocalPassword(profileId, password) {
  const id = String(Number(profileId) || '');
  if (!id) throw new Error('Hồ sơ Affiliate không hợp lệ.');
  const value = String(password ?? '');
  if (!value || value.length > 512) throw new Error('Mật khẩu phải có từ 1 đến 512 ký tự.');
  const stored = await chrome.storage.local.get(AFFILIATE_LOCAL_SECRETS_KEY);
  const secrets = { ...(stored[AFFILIATE_LOCAL_SECRETS_KEY] || {}) };
  secrets[id] = { password: value, updated_at: Date.now() };
  await chrome.storage.local.set({ [AFFILIATE_LOCAL_SECRETS_KEY]: secrets });
}

// ── Browser Helper 2.0: adapter registry + Coupon Discovery ─────────────────
// Đăng ký ở phạm vi module nên chỉ chạy MỘT lần mỗi vòng đời service worker — không sinh listener trùng
// sau mỗi lần kết nối lại, và xoay token chỉ ghi đè storage chứ không phải đăng ký lại.
const adapterRegistry = createRegistry();
const isCouponSourceUrl = (url) => /^https:\/\//.test(url ?? '')
  && !/^https:\/\/(?:www\.)?google\.com\//.test(url ?? '');
adapterRegistry.register({ name: 'valentin', capabilities: ['serp-context'], detect: (ctx) => /^https:\/\/valentin\.app\//.test(ctx?.url ?? ''), start: async () => ({ delegated: 'content/valentin.js' }) });
adapterRegistry.register({ name: 'google-search', capabilities: ['serp', 'coupon-serp'], detect: (ctx) => /^https:\/\/www\.google\.com\/search/.test(ctx?.url ?? ''), start: async () => ({ delegated: 'content/serp.js' }) });
adapterRegistry.register({ name: 'ads-transparency', capabilities: ['advertiser', 'creatives'], detect: (ctx) => /^https:\/\/adstransparency\.google\.com\//.test(ctx?.url ?? ''), start: async () => ({ delegated: 'content/ads-transparency.js' }) });
adapterRegistry.register({ name: 'sitedata-traffic', capabilities: ['monthly-traffic', 'human-challenge'], detect: (ctx) => /^https:\/\/sitedata\.dev\/traffic\//.test(ctx?.url ?? ''), start: async () => ({ delegated: 'content/sitedata-read.js' }) });
adapterRegistry.register({ name: 'coupon-source', capabilities: ['coupon-extract', 'trusted-user-reveal', 'runtime-capture'], detect: (ctx) => isCouponSourceUrl(ctx?.url), start: async () => ({ delegated: 'content/coupon-source-read.js' }) });
// Chưa xây trong đợt này — khai báo interface để Side Panel thấy trước, detect luôn trả false.
adapterRegistry.register({ name: 'keyword-planner', capabilities: ['csv-upload', 'download-track', 'result-sync'], detect: (ctx) => /^https:\/\/ads\.google\.com\//.test(ctx?.url ?? ''), start: async () => ({ delegated: 'content/keyword-planner.js' }) });
adapterRegistry.register({ name: 'affiliate-application', capabilities: ['form-scan', 'profile-fill', 'learned-mapping', 'multi-step'], detect: (ctx) => /^https:\/\//.test(ctx?.url ?? '') && !isHiAutoUrl(ctx?.url), start: async () => ({ delegated: 'content/affiliate-form.js' }) });

const notifyPanel = (payload) => {
  chrome.runtime.sendMessage({ type: 'HELPER_STATE_CHANGED', ...payload }).catch(() => { /* Side Panel đang đóng. */ });
};

const harvester = createHarvesterRuntime({
  storageLocal: chrome.storage.local,
  storageSession: chrome.storage.session,
  scripting: chrome.scripting,
  tabs: chrome.tabs,
  sidePanel: chrome.sidePanel,
  action: chrome.action,
  notify: notifyPanel,
});

async function ensureOcrDocument() {
  const url = chrome.runtime.getURL('offscreen/ocr.html');
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (contexts.length) return;
  }
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen/ocr.html', reasons: ['WORKERS'], justification: 'Run bundled Tesseract OCR locally for ad creatives and coupon images.' });
  } catch (error) {
    if (!/single offscreen|already exists/i.test(String(error?.message ?? error))) throw error;
  }
}

async function runHarvesterOcr(message, sender) {
  if (!sender.tab?.id || sender.frameId !== 0) throw new Error('OCR chỉ chạy trên khung chính đang hiển thị.');
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!tab.active) throw new Error('Hãy giữ tab coupon đang hoạt động để chụp vùng mã.');
  const rect = message.rect ?? {};
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || rect.width * rect.height > 2_000_000) throw new Error('Vùng OCR không hợp lệ.');
  await ensureOcrDocument();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const result = await chrome.runtime.sendMessage({ type: 'HARVESTER_OCR_IMAGE', dataUrl, rect, dpr: Math.min(4, Math.max(1, Number(message.dpr) || 1)) });
  if (!result?.ok || !result.text) return { accepted: 0, error: result?.error ?? 'OCR không đọc được mã.' };
  return harvester.receive({
    type: 'HARVESTER_CANDIDATES', namespace: message.namespace,
    candidates: [{
      rawCode: result.text, hostname: new URL(message.sourceUrl ?? tab.url).hostname,
      sourceUrl: message.sourceUrl ?? tab.url, context: message.context ?? '',
      detectedBy: ['ocr'], explicitLabel: true, nearKeyword: true,
      screenshotCrop: result.screenshotCrop, firstSeen: Date.now(), lastSeen: Date.now(),
    }],
  }, sender);
}

async function runPortfolioOcr(message, sender) {
  if (!sender.tab?.id || sender.frameId !== 0
      || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) {
    throw new Error('OCR dự án chỉ chạy trên profile Ads Transparency đang mở.');
  }
  const creativeId = String(message.creative_id || '');
  if (!/^CR\d+$/.test(creativeId)) throw new Error('Creative ID không hợp lệ.');
  const assetUrls = [...new Set((Array.isArray(message.asset_urls) ? message.asset_urls : [])
    .map((value) => String(value || '').trim()).filter((value) => /^https:\/\//i.test(value)))].slice(0, 8);
  if (!assetUrls.length) throw new Error('Creative không có URL ảnh gốc HTTPS; không dùng ảnh chụp màn hình để đoán domain.');
  await ensureOcrDocument();
  const downloaded = await api('/api/ads-miner/discovery/helper/creative-assets/fetch', {
    method: 'POST', body: { creative_id: creativeId, urls: assetUrls },
  });
  if (!downloaded?.assets?.length) {
    const detail = downloaded?.errors?.map((item) => item.error).filter(Boolean).join(' · ');
    throw new Error(`Không tải được ảnh gốc về Hi Auto${detail ? `: ${detail}` : '.'}`);
  }
  const reads = []; const ocrErrors = []; const minimumAssetMs = 1200;
  for (const asset of downloaded.assets) {
    const startedAt = Date.now();
    try {
      const local = await api(`/api/ads-miner/discovery/helper/creative-assets/${encodeURIComponent(asset.cache_key)}`);
      const result = await chrome.runtime.sendMessage({
        type: 'HARVESTER_OCR_IMAGE', dataUrl: local.data_url, ocr_mode: 'creative-original',
      });
      if (!result?.ok) throw new Error(result?.error || 'Offscreen OCR không phản hồi kết quả hợp lệ.');
      reads.push({ asset, result });
    } catch (error) {
      ocrErrors.push({ cache_key: asset.cache_key,
        error: String(error?.message ?? error).slice(0, 220) });
    } finally {
      const remaining = minimumAssetMs - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }
  if (!reads.length) throw new Error(`OCR ảnh gốc lỗi ${ocrErrors.length}/${downloaded.assets.length}: ${ocrErrors[0]?.error || 'không có chi tiết'}`);
  const uniqueLines = [...new Set(reads.flatMap(({ result }) => String(result?.text || '').split('\n'))
    .map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const text = uniqueLines.join('\n').slice(0, 8000);
  const confidence = Math.max(0, ...reads.map(({ result }) => Number(result?.confidence) || 0));
  return { ok: true, creative_id: creativeId, text, confidence, source: 'original_asset',
    downloaded_count: downloaded.downloaded_count, download_errors: downloaded.errors ?? [],
    ocr_errors: ocrErrors,
    asset_urls: downloaded.assets.map((asset) => asset.asset_url),
    asset_sha256: downloaded.assets.map((asset) => asset.sha256),
    asset_cache_keys: downloaded.assets.map((asset) => asset.cache_key),
    diagnostic: { images_read: reads.length, failed_images: ocrErrors.length,
      empty_images: reads.filter(({ result }) => !result?.text).length,
      reason: text ? null : reads.map(({ result }) => result?.diagnostic?.reason).filter(Boolean)[0]
        || 'Tesseract trả về nội dung trống cho toàn bộ ảnh gốc' } };
}

function assertPortfolioOcrSender(sender) {
  if (!sender.tab?.id || sender.frameId !== 0
      || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) {
    throw new Error('OCR dự án chỉ chạy trên profile Ads Transparency đang mở.');
  }
}

async function startPortfolioOcrBatch(message, sender) {
  assertPortfolioOcrSender(sender);
  const advertiserId = String(message.advertiser_id || '');
  if (!/^AR\d+$/.test(advertiserId)) throw new Error('Advertiser ID không hợp lệ.');
  const creatives = (Array.isArray(message.creatives) ? message.creatives : []).map((item) => ({
    creative_id: String(item?.creative_id || ''),
    asset_urls: [...new Set((Array.isArray(item?.asset_urls) ? item.asset_urls : [])
      .map((value) => String(value || '').trim()).filter((value) => /^https:\/\//i.test(value)))].slice(0, 8),
  })).filter((item) => /^CR\d+$/.test(item.creative_id) && item.asset_urls.length).slice(0, 5000);
  if (!creatives.length) throw new Error('Không có creative kèm URL ảnh gốc để chạy OCR.');
  const result = await api('/api/ads-miner/discovery/helper/creative-ocr/jobs', {
    method: 'POST', body: { advertiser_id: advertiserId, creatives },
  });
  await chrome.storage.session.set({ portfolio_ocr_job: result.job });
  notifyPanel({ kind: 'ads-ocr' });
  return result;
}

async function portfolioOcrBatchStatus(message, sender) {
  assertPortfolioOcrSender(sender);
  const jobId = encodeURIComponent(String(message.job_id || ''));
  const result = await api(`/api/ads-miner/discovery/helper/creative-ocr/jobs/${jobId}${message.include_items === true ? '?include_items=true' : ''}`);
  await chrome.storage.session.set({ portfolio_ocr_job: result.job });
  notifyPanel({ kind: 'ads-ocr' });
  return result;
}

async function cancelPortfolioOcrBatch(message, sender) {
  assertPortfolioOcrSender(sender);
  const jobId = encodeURIComponent(String(message.job_id || ''));
  const result = await api(`/api/ads-miner/discovery/helper/creative-ocr/jobs/${jobId}/cancel`, {
    method: 'POST', body: {},
  });
  await chrome.storage.session.set({ portfolio_ocr_job: result.job });
  notifyPanel({ kind: 'ads-ocr' });
  return result;
}

async function syncPortfolioOcrBatch(message, sender) {
  assertPortfolioOcrSender(sender);
  const jobId = encodeURIComponent(String(message.job_id || ''));
  const result = await api(`/api/ads-miner/discovery/helper/creative-ocr/jobs/${jobId}/synced`, {
    method: 'POST', body: {},
  });
  await chrome.storage.session.set({ portfolio_ocr_job: result.job });
  api('/api/ads-miner/discovery/helper/creative-ocr/cleanup', { method: 'POST', body: {} }).catch(() => null);
  notifyPanel({ kind: 'ads-ocr' });
  return result;
}

const coupon = createOrchestrator({
  api: (path, options) => api(path, options),
  storage: chrome.storage.session,
  tabs: chrome.tabs,
  scripting: chrome.scripting,
  permissions: chrome.permissions,
  harvester,
  notify: notifyPanel,
  searchPacingMs: 1500,
});

async function connectionState() {
  const saved = await savedState();
  if (!saved.helper_token || !saved.local_tab_id) return 'disconnected';
  return Date.now() >= Date.parse(saved.helper_expires_at ?? 0) ? 'expired' : 'connected';
}

async function api(path, options = {}) {
  let saved = await savedState();
  const expiresAt = Date.parse(saved.helper_expires_at ?? 0);
  if (!saved.helper_token || !Number.isFinite(expiresAt) || Date.now() >= expiresAt - 60_000) {
    await renewHelperPairing();
    saved = await savedState();
  }
  const agent = await agentSavedState();
  if (agent.helper_token) {
    try {
      return await localApiViaAgent(path, agent.helper_token, {
        method: options.method ?? 'GET', body: options.body ?? null,
        adsToken: saved.helper_token,
      });
    } catch (error) {
      const pairingRejected = error?.status === 401
        || ['pairing_invalid', 'pairing_required'].includes(error?.code)
        || /pairing[^.]{0,80}(invalid|expired|required)|token[^.]{0,80}(invalid|expired)/i.test(String(error?.message ?? ''));
      if (!pairingRejected) throw error;
      await renewHelperPairing();
      saved = await savedState();
      return localApiViaAgent(path, agent.helper_token, {
        method: options.method ?? 'GET', body: options.body ?? null,
        adsToken: saved.helper_token,
      });
    }
  }
  if (!saved.local_tab_id) throw new Error('Open Hi Auto and connect Browser Helper first.');
  const relay = (auth) => chrome.tabs.sendMessage(auth.local_tab_id, {
    type: 'ADS_DISCOVERY_FETCH', request: {
      path, method: options.method ?? 'GET', body: options.body ?? null, token: auth.helper_token,
    },
  });
  let response = await relay(saved);
  const pairingRejected = !response?.ok && (response?.status === 401
    || ['pairing_invalid', 'pairing_required'].includes(response?.error_code)
    || /pairing[^.]{0,80}(invalid|expired|required)|token[^.]{0,80}(invalid|expired)/i.test(String(response?.error ?? '')));
  if (pairingRejected) {
    await renewHelperPairing();
    saved = await savedState();
    response = await relay(saved);
  }
  if (!response?.ok) throw new Error(response?.error ?? 'Hi Auto relay did not respond.');
  return response.data;
}

async function apiWithRetry(path, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await api(path, options); } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  throw lastError;
}

let trafficDrivePromise = null;
installTrafficWatchdog().catch(() => {});
let trafficAttemptRevision = 0;
const trafficSkippedJobIds = new Set();
let lastTrafficProgressKey = '';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function trafficDetailText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  const message = value?.message || value?.detail?.message || value?.detail || value?.error;
  if (typeof message === 'string') return message;
  try { return JSON.stringify(value); } catch { return 'Lỗi không xác định khi điều khiển SiteData.'; }
}

async function setTrafficProgress(job, stage, reason = null, detail = null) {
  const progress = {
    traffic_job_id: Number(job?.traffic_job_id) || null,
    domain: String(job?.provider_domain || ''),
    stage,
    reason,
    detail: trafficDetailText(detail),
    updated_at: new Date().toISOString(),
  };
  const key = JSON.stringify([progress.traffic_job_id, progress.domain, stage, reason, progress.detail]);
  if (key === lastTrafficProgressKey) return progress;
  lastTrafficProgressKey = key;
  await chrome.storage.session.set({ traffic_progress: progress });
  notifyPanel({ kind: 'traffic' });
  return progress;
}

async function trafficState() {
  const saved = await savedState();
  let remote = { counts: {}, items: [], queued: 0, running: 0, passed: 0, rejected: 0,
    min_visits: 50000, max_visits: 3000000 };
  try { remote = await api('/api/trend-gate/traffic?limit=25&lane=sitedata'); } catch { /* local state still renders */ }
  const manualJob = saved.traffic_job?.lane === 'sitedata' ? saved.traffic_job : null;
  const manualLast = saved.traffic_last_result?.lane === 'sitedata' ? saved.traffic_last_result : null;
  const manualProgress = !saved.traffic_progress?.traffic_job_id || manualJob
    ? saved.traffic_progress ?? null : null;
  const timing = await chrome.storage.local.get([TRAFFIC_NEXT_ALLOWED_KEY, TRAFFIC_COOLDOWN_KEY]);
  return { ...remote, job: manualJob, paused: Boolean(saved.traffic_paused),
    last_result: manualLast,
    progress: manualProgress,
    driver_running: Boolean(trafficDrivePromise),
    auto_enabled: await trafficAutoEnabled(),
    next_allowed_at: Number(timing[TRAFFIC_NEXT_ALLOWED_KEY]) || null,
    cooldown_until: Number(timing[TRAFFIC_COOLDOWN_KEY]) || null };
}

async function waitForTrafficSlot(job) {
  while (true) {
    const timing = await chrome.storage.local.get(TRAFFIC_NEXT_ALLOWED_KEY);
    const remaining = trafficWaitMs(timing[TRAFFIC_NEXT_ALLOWED_KEY]);
    if (remaining <= 0) return true;
    if ((await savedState()).traffic_paused) return false;
    await setTrafficProgress(job, 'pacing', 'sitedata_pacing_wait');
    await wait(Math.min(remaining, 5000));
  }
}

async function markTrafficSubmission() {
  const nextAllowedAt = Date.now() + trafficDomainDelayMs();
  await chrome.storage.local.set({ [TRAFFIC_NEXT_ALLOWED_KEY]: nextAllowedAt });
  return nextAllowedAt;
}

async function startTrafficRateCooldown(job) {
  const cooldownUntil = Date.now() + TRAFFIC_RATE_COOLDOWN_MS;
  await chrome.storage.local.set({ [TRAFFIC_COOLDOWN_KEY]: cooldownUntil });
  await chrome.storage.session.set({ traffic_paused: true });
  await setTrafficProgress(job, 'cooldown', 'sitedata_rate_cooldown');
  return cooldownUntil;
}

async function closeTrafficTab() {
  const saved = await savedState();
  const tabId = Number(saved.traffic_tab_id);
  if (Number.isInteger(tabId) && tabId !== Number(saved.local_tab_id)) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  await chrome.storage.session.remove(['traffic_tab_id']);
}

async function readSiteData(tabId, domain, job = null) {
  let deadline = Date.now() + 30000;
  let revision = trafficAttemptRevision;
  let last = null;
  while (Date.now() < deadline) {
    if (trafficSkippedJobIds.has(Number(job?.traffic_job_id))) {
      return { status: 'skipped', reason: 'user_skipped' };
    }
    if (revision !== trafficAttemptRevision) {
      return { status: 'manual_reset', reason: 'waiting_for_manual_paste' };
    }
    const saved = await savedState();
    if (saved.traffic_paused) return { status: 'needs_user', reason: 'paused_by_user' };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { status: 'failed', reason: 'traffic_tab_closed' };
    if (tab.status === 'loading') await setTrafficProgress(job, 'reading_result', 'page_loading');
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: (value) => {
        if (globalThis.__HI_AUTO_TRAFFIC_DOMAIN__ !== value) globalThis.__HI_AUTO_TRAFFIC_READS__ = 0;
        globalThis.__HI_AUTO_TRAFFIC_DOMAIN__ = value;
        globalThis.__HI_AUTO_TRAFFIC_READS__ = Number(globalThis.__HI_AUTO_TRAFFIC_READS__ || 0) + 1;
      }, args: [domain] });
      const injected = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/sitedata-read.js'] });
      last = injected?.[0]?.result ?? null;
      if (last && last.status !== 'loading') return last;
      await setTrafficProgress(job, 'reading_result', last?.reason || 'waiting_for_traffic_data');
    } catch { /* Navigation/document not ready yet. */ }
    // DOM polling is local only, but a slower cadence gives the real page time to settle naturally.
    await wait(trafficPollDelayMs());
  }
  return { status: 'failed', reason: last?.reason || 'sitedata_timeout' };
}

async function fillSiteDataSearch(tabId, domain, job = null) {
  const deadline = Date.now() + 10000;
  let last = null;
  while (Date.now() < deadline) {
    if (trafficSkippedJobIds.has(Number(job?.traffic_job_id))) {
      return { status: 'skipped', reason: 'user_skipped' };
    }
    const saved = await savedState();
    if (saved.traffic_paused) return { status: 'needs_user', reason: 'paused_by_user' };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { status: 'failed', reason: 'traffic_tab_closed' };
    if (tab.status === 'loading') await setTrafficProgress(job, 'opening_site', 'page_loading');
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: (value) => {
        globalThis.__HI_AUTO_TRAFFIC_DOMAIN__ = value;
        globalThis.__HI_AUTO_TRAFFIC_READS__ = 0;
      }, args: [domain] });
      const injected = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/sitedata-search.js'] });
      last = injected?.[0]?.result ?? null;
      if (last && last.status !== 'loading') return last;
      await setTrafficProgress(job, 'filling_search', last?.reason || 'waiting_for_search_form');
    } catch { /* Navigation/document not ready yet. */ }
    await wait(trafficPollDelayMs());
  }
  return { status: 'needs_user', reason: last?.reason || 'search_form_timeout' };
}

async function submitSiteDataSearch(tabId, domain, job = null) {
  const deadline = Date.now() + 15000;
  let last = null;
  while (Date.now() < deadline) {
    if (trafficSkippedJobIds.has(Number(job?.traffic_job_id))) {
      return { status: 'skipped', reason: 'user_skipped' };
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { status: 'failed', reason: 'traffic_tab_closed' };
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: (value) => {
        globalThis.__HI_AUTO_TRAFFIC_DOMAIN__ = value;
      }, args: [domain] });
      const injected = await chrome.scripting.executeScript({
        target: { tabId }, files: ['content/sitedata-auto-search.js'],
      });
      last = injected?.[0]?.result ?? null;
      if (last && last.status !== 'loading') return last;
      await setTrafficProgress(job, 'filling_search', last?.reason || 'waiting_for_search_form');
    } catch { /* Navigation/document not ready yet. */ }
    await wait(trafficPollDelayMs());
  }
  return { status: 'failed', reason: last?.reason || 'search_form_timeout' };
}

async function waitForAutoSiteDataResult(tabId, domain, job = null) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (trafficSkippedJobIds.has(Number(job?.traffic_job_id))) {
      return { status: 'skipped', reason: 'user_skipped' };
    }
    const saved = await savedState();
    if (saved.traffic_paused) return { status: 'needs_user', reason: 'paused_by_user' };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { status: 'failed', reason: 'traffic_tab_closed' };
    try {
      const current = new URL(String(tab.url || tab.pendingUrl || ''));
      const resultPage = current.origin === 'https://sitedata.dev'
        && /\/(?:[a-z]{2}\/)?traffic\//i.test(current.pathname);
      const matchingDomain = resultPage
        && decodeURIComponent(current.pathname).toLowerCase().includes(String(domain).toLowerCase());
      if (matchingDomain) {
        await setTrafficProgress(job, 'reading_result', 'manual_result_detected');
        return readSiteData(tabId, domain, job);
      }
      if (resultPage) await setTrafficProgress(job, 'reading_result', 'waiting_for_domain');
      else await setTrafficProgress(job, 'awaiting_result', 'auto_search_submitted');
    } catch { /* Chrome is between documents. */ }
    await wait(trafficPollDelayMs());
  }
  return { status: 'failed', reason: 'auto_search_timeout' };
}

async function waitForManualSiteDataResult(tabId, domain, job = null) {
  while (true) {
    if (trafficSkippedJobIds.has(Number(job?.traffic_job_id))) {
      return { status: 'skipped', reason: 'user_skipped' };
    }
    const saved = await savedState();
    if (saved.traffic_paused) return { status: 'needs_user', reason: 'paused_by_user' };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { status: 'failed', reason: 'traffic_tab_closed' };
    let resultPage = false;
    let matchingDomain = false;
    try {
      const current = new URL(String(tab.url || tab.pendingUrl || ''));
      resultPage = current.origin === 'https://sitedata.dev'
        && /\/(?:[a-z]{2}\/)?traffic\//i.test(current.pathname);
      matchingDomain = resultPage
        && decodeURIComponent(current.pathname).toLowerCase().includes(String(domain).toLowerCase());
    } catch { /* Keep waiting while Chrome swaps documents. */ }
    if (resultPage && matchingDomain) {
      await setTrafficProgress(job, 'reading_result', 'manual_result_detected');
      return readSiteData(tabId, domain, job);
    }
    if (resultPage) {
      await setTrafficProgress(job, 'awaiting_manual_search', 'waiting_for_domain');
    } else {
      const currentProgress = Number(saved.traffic_progress?.traffic_job_id) === Number(job?.traffic_job_id)
        ? saved.traffic_progress : null;
      if (currentProgress?.stage !== 'issue') {
        await setTrafficProgress(job, 'awaiting_manual_search',
          currentProgress?.reason === 'domain_filled_waiting_for_search'
            ? 'domain_filled_waiting_for_search' : 'waiting_for_manual_paste');
      }
    }
    await wait(Math.max(500, trafficPollDelayMs()));
  }
}

async function openTrafficTab(previous, job, searchUrl) {
  const tabId = Number(previous.traffic_tab_id);
  let tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab && !String(tab.url || tab.pendingUrl || '').startsWith('https://sitedata.dev/')) tab = null;
  if (!tab) {
    await closeTrafficTab();
    tab = await chrome.tabs.create({ url: searchUrl, active: true });
    await chrome.storage.session.set({ traffic_tab_id: tab.id });
    return { tab, resumeResult: false };
  }
  let matchingResultPage = false;
  try {
    const current = new URL(String(tab.url || tab.pendingUrl || ''));
    matchingResultPage = current.origin === 'https://sitedata.dev'
      && current.pathname.toLowerCase().includes(`/traffic/${String(job.provider_domain).toLowerCase()}`);
  } catch { /* A half-loaded tab is not a resumable result page. */ }
  const sameJob = Number(previous.traffic_job?.traffic_job_id) === Number(job.traffic_job_id);
  let homePage = false;
  try {
    const current = new URL(String(tab.url || tab.pendingUrl || ''));
    homePage = current.origin === 'https://sitedata.dev'
      && (current.pathname === '/' || /^\/[a-z]{2}\/?$/i.test(current.pathname));
  } catch { /* A half-loaded tab is not reusable yet. */ }
  const preservePage = sameJob && (matchingResultPage || homePage);
  tab = await chrome.tabs.update(tab.id, preservePage ? { active: true } : { url: searchUrl, active: true });
  return { tab, resumeResult: sameJob && matchingResultPage };
}

async function driveTrafficQueue({ maxJobs = TRAFFIC_BATCH_SIZE } = {}) {
  if (trafficDrivePromise) return trafficDrivePromise;
  trafficDrivePromise = (async () => {
    let completed = 0;
    while (completed < maxJobs) {
      let previous = await savedState();
      const timing = await chrome.storage.local.get(TRAFFIC_COOLDOWN_KEY);
      if (trafficWaitMs(timing[TRAFFIC_COOLDOWN_KEY]) > 0) {
        await chrome.storage.session.set({ traffic_paused: true });
        await setTrafficProgress(previous.traffic_job, 'cooldown', 'sitedata_rate_cooldown');
        break;
      }
      if (previous.traffic_paused) break;
      const resumable = previous.traffic_job?.status === 'running'
        && previous.traffic_job?.lane === 'sitedata' ? previous.traffic_job : null;
      const claimed = resumable ? { job: resumable }
        : await api('/api/trend-gate/traffic/helper/claim', { method: 'POST', body: {} });
      const job = claimed?.job;
      if (!job) { await closeTrafficTab(); break; }
      await chrome.storage.session.set({ traffic_job: job, traffic_paused: false });
      await setTrafficProgress(job, 'opening_site', 'opening_sitedata');
      notifyPanel({ kind: 'traffic' });
      const searchUrl = 'https://sitedata.dev/';
      const resultUrl = `https://sitedata.dev/traffic/${encodeURIComponent(job.provider_domain)}`;
      let read = null;
      for (let reopenAttempt = 0; reopenAttempt < 3; reopenAttempt += 1) {
        const opened = await openTrafficTab(previous, job, searchUrl);
        await setTrafficProgress(job, opened.resumeResult ? 'reading_result' : 'filling_search',
          opened.resumeResult ? 'resume_result_page' : 'auto_filling_domain');
        if (opened.resumeResult) {
          read = await readSiteData(opened.tab.id, job.provider_domain, job);
        } else {
          if (!(await waitForTrafficSlot(job))) {
            read = { status: 'needs_user', reason: 'paused_by_user' };
            break;
          }
          const submitted = await submitSiteDataSearch(opened.tab.id, job.provider_domain, job);
          if (submitted.status === 'submitted') await markTrafficSubmission();
          if (['needs_user', 'quota', 'failed', 'skipped'].includes(submitted.status)) read = submitted;
          else read = await waitForAutoSiteDataResult(opened.tab.id, job.provider_domain, job);
        }
        if (read?.reason !== 'traffic_tab_closed') break;
        await chrome.storage.session.remove(['traffic_tab_id']);
        await setTrafficProgress(job, 'reopening_tab', 'traffic_tab_reopening');
        previous = await savedState();
      }
      read ||= { status: 'failed', reason: 'traffic_tab_reopen_failed' };
      if (read.status === 'skipped' || trafficSkippedJobIds.has(Number(job.traffic_job_id))) {
        trafficSkippedJobIds.delete(Number(job.traffic_job_id));
        completed += 1;
        continue;
      }
      // Technical stalls are actionable: keep the domain visible instead of silently moving on.
      const resultStatus = ['ok', 'no_data', 'needs_user', 'quota'].includes(read.status)
        ? read.status : 'failed';
      await setTrafficProgress(job,
        ['needs_user', 'quota'].includes(resultStatus) ? 'issue' : 'completed',
        read.reason || resultStatus);
      if (trafficSkippedJobIds.has(Number(job.traffic_job_id))) {
        trafficSkippedJobIds.delete(Number(job.traffic_job_id));
        completed += 1;
        continue;
      }
      const result = await api(`/api/trend-gate/traffic/helper/jobs/${job.traffic_job_id}/complete`, {
        method: 'POST', body: { result_status: resultStatus, monthly_visits: read.monthly_visits,
          source_url: read.source_url || resultUrl, error: read.reason || null },
      });
      const completedResult = { ...job, ...result };
      await chrome.storage.session.set({ traffic_job: completedResult, traffic_last_result: completedResult });
      await notifyUi(); notifyPanel({ kind: 'traffic' }); completed += 1;
      if (result.status === 'quota' && isTrafficRateReason(read.reason)) {
        await startTrafficRateCooldown(completedResult);
        break;
      }
      if (['needs_user', 'quota'].includes(result.status)) {
        await chrome.storage.session.set({ traffic_paused: true });
        break;
      }
    }
    if (!(await savedState()).traffic_paused) await closeTrafficTab();
    return { completed, message: completed ? `Đã kiểm traffic ${completed} dự án.` : 'Hàng kiểm traffic đã hết.' };
  })();
  try { return await trafficDrivePromise; }
  catch (error) {
    const saved = await savedState();
    await chrome.storage.session.set({ traffic_paused: true });
    await setTrafficProgress(saved.traffic_job, 'issue', 'helper_error', error?.message || error);
    throw error;
  }
  finally { trafficDrivePromise = null; }
}

async function trafficAutoEnabled() {
  return Boolean((await chrome.storage.local.get('traffic_auto_enabled')).traffic_auto_enabled);
}

async function resumeTrafficAuto() {
  if (!(await trafficAutoEnabled()) || trafficDrivePromise) return false;
  let saved = await savedState();
  const timing = await chrome.storage.local.get(TRAFFIC_COOLDOWN_KEY);
  const cooldownUntil = Number(timing[TRAFFIC_COOLDOWN_KEY]) || 0;
  if (trafficWaitMs(cooldownUntil) > 0) return false;
  if (cooldownUntil) {
    let held = saved.traffic_job;
    if (!held?.traffic_job_id) {
      const remote = await api('/api/trend-gate/traffic?limit=25&lane=sitedata').catch(() => ({ items: [] }));
      held = remote?.items?.find((item) => item.status === 'quota'
        && isTrafficRateReason(item.last_error || item.reason)) ?? null;
    }
    if (held?.traffic_job_id && held?.lane === 'sitedata' && held.status === 'quota') {
      await api(`/api/trend-gate/traffic/helper/jobs/${held.traffic_job_id}/retry`, { method: 'POST', body: {} });
      await chrome.storage.session.set({ traffic_job: { ...held, status: 'queued' }, traffic_paused: false });
    } else {
      await chrome.storage.session.set({ traffic_paused: false });
    }
    await chrome.storage.local.remove(TRAFFIC_COOLDOWN_KEY);
    saved = await savedState();
  }
  if (saved.traffic_paused) return false;
  await api('/api/trend-gate/traffic/queue', { method: 'POST', body: { limit: null } });
  driveTrafficQueue({ maxJobs: Number.MAX_SAFE_INTEGER }).catch(async (error) => {
    await chrome.storage.session.set({ traffic_paused: false });
    await setTrafficProgress((await savedState()).traffic_job, 'issue', 'helper_error', error?.message || error);
  });
  return true;
}

async function installTrafficWatchdog() {
  await chrome.alarms.create(TRAFFIC_AUTO_ALARM, { periodInMinutes: 1 });
  return resumeTrafficAuto();
}

async function claimAndOpenKeywordPlanner({ resumeHeld = false } = {}) {
  const previous = await savedState();
  const claimed = await api('/api/demand/helper/claim', { method: 'POST', body: {
    resume_held: resumeHeld,
    job_id: resumeHeld ? previous.keyword_planner_command?.job_id ?? null : null,
  } });
  const job = claimed?.job;
  if (!job) {
    const saved = await savedState();
    const tabId = Number(saved.keyword_planner_tab_id);
    if (Number.isInteger(tabId) && tabId !== Number(saved.local_tab_id)) {
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
    await chrome.storage.session.remove(['keyword_planner_command', 'keyword_planner_tab_id', 'keyword_planner_download_id']);
    await notifyUi();
    return { message: 'Đã xử lý hết batch Keyword Planner.' };
  }
  const command = { ...job, requested_at: Date.now() };
  let tab;
  let reusedCurrentPage = false;
  if (previous.keyword_planner_tab_id) {
    try {
      const current = await chrome.tabs.get(Number(previous.keyword_planner_tab_id));
      reusedCurrentPage = shouldReusePlannerTab(current?.url, resumeHeld);
      tab = await chrome.tabs.update(Number(previous.keyword_planner_tab_id), reusedCurrentPage
        ? { active: true }
        : { url: job.planner_url, active: true });
    } catch { /* closed */ }
  }
  if (!tab) tab = await chrome.tabs.create({ url: job.planner_url, active: true });
  await chrome.storage.session.set({ keyword_planner_command: command, keyword_planner_tab_id: tab.id });
  if (reusedCurrentPage) {
    // Người dùng vừa login/mở đúng màn upload/CAPTCHA. Không reload về Home và làm mất thao tác đó.
    // Extension vừa Reload thì content script trong document cũ đã chết. Chủ động bơm bản mới, idempotent,
    // rồi gửi lệnh chạy; callback cố ý không chờ cả chu kỳ Google xử lý tối đa 90 giây.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/keyword-planner.js'] });
      chrome.tabs.sendMessage(tab.id, { type: 'RESUME_KEYWORD_PLANNER' }, () => void chrome.runtime.lastError);
    } catch (error) {
      await api(`/api/demand/helper/jobs/${job.job_id}/progress`, { method: 'POST', body: {
        status: 'needs_user', stage: 'content_injection_failed', error_code: 'ELEMENT_NOT_FOUND',
        error_message: `Không thể chạy Helper trong tab Google Ads: ${String(error?.message || error).slice(0, 280)}`,
      } }).catch(() => {});
      throw error;
    }
  }
  notifyPanel({ log: reusedCurrentPage
    ? `Keyword Planner: tiếp tục ${job.input_name} ngay trên màn hiện tại.`
    : `Keyword Planner: đang xử lý ${job.input_name}.`, kind: 'ok' });
  return { message: reusedCurrentPage
    ? `Đang tiếp tục ${job.input_name} trên đúng màn Keyword Planner hiện tại.`
    : `Đang gửi ${job.input_name} sang Keyword Planner.`, job };
}

async function startKeywordPlannerQueue() {
  // Reload extension có thể làm mất command cục bộ trong khi backend vẫn giữ part đang chạy/chờ người.
  // Khi bấm lại từ Hi Auto phải nối vào batch đó, tuyệt đối không export thêm một batch giống hệt.
  const listed = await api('/api/demand/helper/jobs?limit=200');
  const hasOpenJob = (listed?.items ?? []).some((job) =>
    ['queued', 'running', 'needs_login', 'needs_user'].includes(job.status));
  const prepared = hasOpenJob
    ? null
    : await api('/api/demand/helper/prepare', { method: 'POST', body: {} });
  const started = await claimAndOpenKeywordPlanner({ resumeHeld: hasOpenJob });
  return {
    ...started,
    prepared,
    message: hasOpenJob
      ? `Đã nối lại batch Keyword Planner đang dở. ${started.message}`
      : started.message,
  };
}

async function finishKeywordPlannerDownload(downloadId) {
  const [item] = await chrome.downloads.search({ id: Number(downloadId) });
  const saved = await savedState();
  const command = saved.keyword_planner_command;
  if (!command?.job_id || !item?.filename || item.state !== 'complete') return;
  try {
    await api(`/api/demand/helper/jobs/${command.job_id}/complete`, {
      method: 'POST', body: { result_path: item.filename, download_id: item.id },
    });
    await chrome.storage.session.remove(['keyword_planner_command', 'keyword_planner_download_id']);
    await notifyUi();
    await claimAndOpenKeywordPlanner();
  } catch (error) {
    await api(`/api/demand/helper/jobs/${command.job_id}/progress`, {
      method: 'POST', body: { status: 'needs_user', stage: 'download_parse_failed',
        error_code: 'BAD_RESULT_FILE', error_message: String(error.message).slice(0, 400) },
    }).catch(() => {});
    notifyPanel({ log: `Keyword Planner: ${error.message}`, kind: 'error' });
  }
}

async function injectAffiliateForm(tabId) {
  const saved = await savedState();
  if (Number(saved.affiliate_application_tab_id) !== Number(tabId) || !saved.affiliate_application_command) return;
  if (affiliateInjectedTabs.has(Number(tabId))) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: Number(tabId), allFrames: true }, files: ['content/affiliate-form.js'] });
    affiliateInjectedTabs.add(Number(tabId));
  } catch (error) {
    await api(`/api/ads-miner/affiliate-helper/helper/jobs/${saved.affiliate_application_command.job_id}/progress`, {
      method: 'POST', body: { status: 'needs_user', stage: 'injection_failed', error_code: 'PERMISSION_MISSING',
        error_message: String(error.message).slice(0, 400) },
    }).catch(() => {});
  }
}

function affiliateFrameScore(scan, frameId) {
  const fields = Math.min(Number(scan?.fields?.length || 0), 500);
  const embedded = Number(frameId) > 0 ? 2000 : 0;
  const popup = scan?.surface === 'popup'
    ? (scan?.popup_frame_origins?.length ? 1000 : 3000) : 0;
  return embedded + popup + fields;
}

function affiliateFrameOptions(saved) {
  const frameId = Number(saved?.affiliate_application_frame_id);
  return Number.isInteger(frameId) && frameId >= 0 ? { frameId } : undefined;
}

async function sendAffiliateTabMessage(saved, message) {
  const tabId = Number(saved?.affiliate_application_tab_id);
  if (!Number.isInteger(tabId)) throw new Error('Không tìm thấy tab form Affiliate đang mở.');
  const options = affiliateFrameOptions(saved);
  return options ? chrome.tabs.sendMessage(tabId, message, options) : chrome.tabs.sendMessage(tabId, message);
}

async function adoptAffiliatePopupTab(tabId) {
  const saved = await savedState();
  const command = saved.affiliate_application_command;
  if (!command?.job_id) return false;
  let tab;
  try { tab = await chrome.tabs.get(Number(tabId)); } catch { return false; }
  const belongsToJob = Number(saved.affiliate_popup_candidate_tab_id) === Number(tabId)
    || Number(tab.openerTabId) === Number(saved.affiliate_application_tab_id);
  if (!belongsToJob) return false;
  let url;
  try { url = new URL(String(tab.url || tab.pendingUrl || '')); } catch { return false; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== command.application_host) return false;
  const origin = `${url.origin}/*`;
  if (!await chrome.permissions.contains({ origins: [origin] })) return false;
  await chrome.storage.session.set({ affiliate_application_tab_id: Number(tabId),
    affiliate_application_frame_id: 0, affiliate_application_frame_score: -1,
    affiliate_application_frame_seen_at: Date.now(), affiliate_popup_allowed_origins: [],
    affiliate_fill_plan: null });
  await chrome.storage.session.remove(['affiliate_popup_candidate_tab_id']);
  affiliateInjectedTabs.delete(Number(tabId));
  await injectAffiliateForm(Number(tabId));
  notifyPanel({ log: `Đã chuyển sang popup đăng ký ${url.hostname} và bắt đầu quét form.`, kind: 'ok' });
  return true;
}

let affiliateRecovery = null;
let affiliateRecoveryCheckedAt = 0;

async function recoverAffiliateApplication({ manual = false } = {}) {
  if (affiliateRecovery) return affiliateRecovery;
  affiliateRecovery = (async () => {
    const saved = await savedState();
    let job = saved.affiliate_application_command ?? null;
    let tabs = [];

    if (recoverableAffiliateJob(job)) {
      const trackedId = Number(saved.affiliate_application_tab_id);
      if (Number.isInteger(trackedId)) {
        try {
          const tracked = await chrome.tabs.get(trackedId);
          if (affiliateTabMatches(job, tracked)) tabs = [tracked];
        } catch { /* The tracked tab disappeared; find the same form host below. */ }
      }
      if (!tabs.length) tabs = await chrome.tabs.query({});
    } else {
      if (!manual && Date.now() - affiliateRecoveryCheckedAt < 10_000) {
        return { recovered: false, reason: 'recently_checked' };
      }
      affiliateRecoveryCheckedAt = Date.now();
      if (!manual && await connectionState() !== 'connected') {
        return { recovered: false, reason: 'disconnected' };
      }
      const current = await api('/api/ads-miner/affiliate-helper/jobs/current');
      job = current?.job ?? null;
      if (!recoverableAffiliateJob(job)) return { recovered: false, reason: 'no_open_job' };
      // Automatic recovery is intentionally strict: the current visible tab must be the exact form host.
      // A manual click may recover another open tab of that same host, but never an unrelated tab.
      tabs = manual
        ? await chrome.tabs.query({})
        : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }

    const tab = chooseAffiliateRecoveryTab(job, tabs);
    if (!tab) return { recovered: false, reason: 'form_tab_not_found', job };
    const origin = `${new URL(String(tab.url || tab.pendingUrl)).origin}/*`;
    if (!await chrome.permissions.contains({ origins: [origin] })) {
      return { recovered: false, reason: 'permission_missing', permission_origin: origin, job };
    }
    const persistedPlan = saved.affiliate_fill_plan
      || (job.fill_plan && Object.keys(job.fill_plan).length ? job.fill_plan : null);
    const displayPlan = await markAffiliateLocalSecrets(persistedPlan, job);
    const sameTrackedTab = Number(saved.affiliate_application_tab_id) === Number(tab.id);
    const savedFrameId = Number(saved.affiliate_application_frame_id);
    const patch = { ...recoveredAffiliateState(job, tab, displayPlan),
      affiliate_application_frame_id: sameTrackedTab && Number.isInteger(savedFrameId) ? savedFrameId : 0,
      affiliate_application_frame_score: sameTrackedTab
        ? Number(saved.affiliate_application_frame_score ?? -1) : -1,
      affiliate_application_frame_seen_at: Date.now(),
      affiliate_popup_allowed_origins: sameTrackedTab
        ? (saved.affiliate_popup_allowed_origins || []) : (displayPlan?.popup_frame_origins || []) };
    await chrome.storage.session.set(patch);
    await injectAffiliateForm(tab.id);
    notifyPanel({ log: `Đã nhận lại form ${job.brand_name || job.application_host} và tiếp tục quét.`, kind: 'ok' });
    return { recovered: true, job, plan: displayPlan, tab_id: tab.id,
      message: `Đã nhận lại form ${job.brand_name || job.application_host}; bạn có thể tiếp tục ngay.` };
  })().finally(() => { affiliateRecovery = null; });
  return affiliateRecovery;
}

async function refreshAffiliateCurrentState() {
  const recovered = await recoverAffiliateApplication({ manual: true });
  if (!recovered.recovered) return recovered;
  const saved = await savedState();
  const tabId = Number(saved.affiliate_application_tab_id);
  if (!Number.isInteger(tabId)) throw new Error('Không tìm thấy tab form Affiliate đang mở.');
  let response;
  try {
    response = await sendAffiliateTabMessage(saved, { type: 'AFFILIATE_REFRESH_STATE' });
  } catch {
    // The page may still contain an invalidated content world after Extension Reload.
    // Reinject once and retry against the same verified tab instead of restarting the job.
    affiliateInjectedTabs.delete(tabId);
    await injectAffiliateForm(tabId);
    response = await sendAffiliateTabMessage(await savedState(), { type: 'AFFILIATE_REFRESH_STATE' });
  }
  if (!response?.ok) throw new Error(response?.error || 'Không thể đọc lại form Affiliate hiện tại.');
  return { ...recovered, rescanned: true,
    message: `Đã quét lại hiện trạng ${saved.affiliate_application_command?.brand_name || 'form Affiliate'} và cập nhật Panel.` };
}

async function startAffiliateApplication(message) {
  const url = new URL(String(message.application_url || ''));
  if (url.protocol !== 'https:' || !url.hostname.includes('.')) throw new Error('URL đăng ký affiliate phải là HTTPS công khai.');
  const originPattern = `${url.origin}/*`;
  const granted = await chrome.permissions.contains({ origins: [originPattern] });
  if (!granted) throw new Error(`Bạn chưa cấp quyền cho ${url.hostname}; hãy bấm lại từ Hi Auto.`);
  const job = await api('/api/ads-miner/affiliate-helper/jobs', {
    method: 'POST', body: { candidate_id: Number(message.candidate_id), application_url: url.href,
      profile_id: Number(message.profile_id), variant_id: message.variant_id ? Number(message.variant_id) : null },
  });
  const previous = await savedState();
  if (Number.isInteger(Number(previous.affiliate_application_tab_id))
      && Number(previous.affiliate_application_tab_id) !== Number(previous.local_tab_id)) {
    await chrome.storage.session.remove(['affiliate_application_command', 'affiliate_application_tab_id',
      'affiliate_application_frame_id', 'affiliate_application_frame_score',
      'affiliate_application_frame_seen_at', 'affiliate_popup_allowed_origins',
      'affiliate_popup_candidate_tab_id', 'affiliate_fill_plan']);
    try { await chrome.tabs.remove(Number(previous.affiliate_application_tab_id)); } catch { /* already closed */ }
  }
  const tab = await chrome.tabs.create({ url: job.application_url, active: true });
  await chrome.storage.session.set({ affiliate_application_command: job,
    affiliate_application_tab_id: tab.id, affiliate_application_frame_id: 0,
    affiliate_application_frame_score: -1, affiliate_application_frame_seen_at: Date.now(),
    affiliate_popup_allowed_origins: [], affiliate_fill_plan: null, affiliate_ai_suggestions: [] });
  notifyPanel({ log: `Đang quét form đăng ký ${job.brand_name}.`, kind: 'ok' });
  return { message: `Đã mở form đăng ký ${job.brand_name}.`, job };
}

async function startAffiliateSearch(message) {
  const searchUrl = new URL(String(message.search_url || ''));
  if (searchUrl.protocol !== 'https:' || searchUrl.hostname !== 'www.google.com'
      || searchUrl.pathname !== '/search') {
    throw new Error('Truy vấn tìm chương trình phải là Google Search hợp lệ.');
  }
  const candidateId = Number(message.candidate_id);
  if (!Number.isInteger(candidateId) || candidateId <= 0) throw new Error('Dự án affiliate không hợp lệ.');
  const previous = await savedState();
  if (previous.affiliate_application_command?.job_id) {
    await api(`/api/ads-miner/affiliate-helper/helper/jobs/${previous.affiliate_application_command.job_id}/progress`, {
      method: 'POST', body: { status: 'cancelled', stage: 'superseded_by_new_search' },
    }).catch(() => {});
  }
  const previousTabIds = [...new Set([
    previous.affiliate_application_tab_id, previous.affiliate_search_tab_id,
    previous.affiliate_search_root_tab_id,
  ].map(Number).filter((id) => Number.isInteger(id) && id !== Number(previous.local_tab_id)))];
  // Xóa ownership cũ trước khi đóng tab để listener onRemoved không thể xóa nhầm phiên mới vừa tạo.
  await chrome.storage.session.remove([
    'affiliate_search_session', 'affiliate_search_root_tab_id', 'affiliate_search_tab_id',
    'affiliate_application_command', 'affiliate_application_tab_id', 'affiliate_application_frame_id',
    'affiliate_application_frame_score', 'affiliate_application_frame_seen_at',
    'affiliate_popup_allowed_origins', 'affiliate_popup_candidate_tab_id', 'affiliate_fill_plan',
    'affiliate_ai_suggestions', 'affiliate_auto_fill_pending',
  ]);
  if (previousTabIds.length) await chrome.tabs.remove(previousTabIds).catch(() => {});
  const session = {
    candidate_id: candidateId,
    brand_name: String(message.brand_name || 'Dự án affiliate').slice(0, 200),
    provider_domain: String(message.provider_domain || '').slice(0, 300),
    search_url: searchUrl.href,
    stage: 'searching_google',
    started_at: Date.now(),
  };
  // Lưu ownership trước khi Google tải để content script không thể nhận nhầm đây là Ads Discovery.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  try {
    await chrome.storage.session.set({ affiliate_search_session: session,
      affiliate_search_root_tab_id: tab.id, affiliate_search_tab_id: tab.id });
    await chrome.tabs.update(tab.id, { url: searchUrl.href, active: true });
  } catch (error) {
    await chrome.storage.session.remove(['affiliate_search_session', 'affiliate_search_root_tab_id',
      'affiliate_search_tab_id']);
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
  notifyPanel({ log: `Đang chờ bạn chọn trang đăng ký cho ${session.brand_name} trên Google.`, kind: 'ok' });
  return { message: 'Đã mở Google. Hãy chọn thủ công trang Affiliate/Partner phù hợp.', session, tab_id: tab.id };
}

async function startDomainVerification(message) {
  const searchUrl = new URL(String(message.search_url || ''));
  if (searchUrl.protocol !== 'https:' || searchUrl.hostname !== 'www.google.com'
      || searchUrl.pathname !== '/search') {
    throw new Error('Truy vấn xác minh domain phải là Google Search hợp lệ.');
  }
  const sessionId = String(message.session_id || '').trim();
  const projectId = String(message.project_id || '').trim();
  if (!/^adsds_[a-z0-9]+$/i.test(sessionId) || !/^project_[a-z0-9]+$/i.test(projectId)) {
    throw new Error('Dự án Ads Discovery cần xác minh không hợp lệ.');
  }
  const previous = await savedState();
  const previousTabIds = [...new Set([
    previous.affiliate_application_tab_id, previous.affiliate_search_tab_id,
    previous.affiliate_search_root_tab_id,
  ].map(Number).filter((id) => Number.isInteger(id) && id !== Number(previous.local_tab_id)))];
  await chrome.storage.session.remove([
    'affiliate_search_session', 'affiliate_search_root_tab_id', 'affiliate_search_tab_id',
    'affiliate_application_command', 'affiliate_application_tab_id', 'affiliate_application_frame_id',
    'affiliate_application_frame_score', 'affiliate_application_frame_seen_at',
    'affiliate_popup_allowed_origins', 'affiliate_popup_candidate_tab_id', 'affiliate_fill_plan',
    'affiliate_ai_suggestions', 'affiliate_auto_fill_pending',
  ]);
  if (previousTabIds.length) await chrome.tabs.remove(previousTabIds).catch(() => {});
  const session = {
    purpose: 'domain_verification', session_id: sessionId, project_id: projectId,
    brand_name: String(message.brand_name || 'Dự án').slice(0, 200),
    search_query: String(message.search_query || '').slice(0, 300),
    search_url: searchUrl.href, stage: 'searching_google', started_at: Date.now(),
  };
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  try {
    await chrome.storage.session.set({ affiliate_search_session: session,
      affiliate_search_root_tab_id: tab.id, affiliate_search_tab_id: tab.id });
    await chrome.tabs.update(tab.id, { url: searchUrl.href, active: true });
  } catch (error) {
    await chrome.storage.session.remove(['affiliate_search_session', 'affiliate_search_root_tab_id',
      'affiliate_search_tab_id']);
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
  notifyPanel({ log: `Chờ bạn chọn website chính thức của ${session.brand_name} trên Google.`, kind: 'ok' });
  return { message: `Đã mở Google với key “${session.search_query}”. Hãy tự chọn website đúng.`,
    session, tab_id: tab.id };
}

async function finishDomainVerification(tabId, { retry = false } = {}) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || domainVerificationInFlight.has(id)) return { ignored: true };
  const saved = await savedState();
  const session = saved.affiliate_search_session;
  if (session?.purpose !== 'domain_verification'
      || id !== Number(saved.affiliate_search_tab_id)) return { ignored: true };
  if (!retry && ['verifying', 'completed'].includes(session.stage)) return { ignored: true };
  const tab = await chrome.tabs.get(id);
  const url = new URL(String(tab.url || tab.pendingUrl || ''));
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')
      || url.hostname === 'www.google.com' || isHiAutoUrl(url.href)) return { ignored: true };
  domainVerificationInFlight.add(id);
  await chrome.storage.session.set({ affiliate_search_session: {
    ...session, stage: 'verifying', current_url: url.href, current_host: url.hostname,
    error_message: null,
  } });
  notifyPanel({ log: `Đã nhận ${url.hostname}; đang lưu domain và xếp hàng traffic.`, kind: 'ok' });
  try {
    const result = await api(`/api/ads-miner/discovery/helper/projects/${encodeURIComponent(session.project_id)}/verify-domain`, {
      method: 'POST', body: { selected_url: url.href },
    });
    const queued = result.pipeline_stage === 'traffic_queued';
    const completed = { ...session, stage: queued ? 'completed' : 'failed', current_url: url.href,
      current_host: result.provider_domain || url.hostname, provider_domain: result.provider_domain,
      pipeline_stage: result.pipeline_stage, handoff: result.handoff,
      error_message: queued ? null : String(result.handoff?.error || result.handoff?.message
        || 'Hi Auto chưa xếp được hàng traffic.').slice(0, 300) };
    await chrome.storage.session.set({ affiliate_search_session: completed });
    await notifyUi({ notice: result.message, domain_verification_result: result });
    notifyPanel({ log: result.message, kind: 'ok' });
    const rootTabId = Number(saved.affiliate_search_root_tab_id);
    if (Number.isInteger(rootTabId) && rootTabId !== id) {
      await chrome.tabs.remove(rootTabId).catch(() => {});
      await chrome.storage.session.remove('affiliate_search_root_tab_id');
    }
    return result;
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300);
    await chrome.storage.session.set({ affiliate_search_session: {
      ...session, stage: 'failed', current_url: url.href, current_host: url.hostname,
      error_message: message,
    } });
    notifyPanel({ log: `Xác minh domain lỗi: ${message}`, kind: 'error' });
    throw error;
  } finally {
    domainVerificationInFlight.delete(id);
  }
}

async function startAffiliateFromSearch(message) {
  const saved = await savedState();
  const session = saved.affiliate_search_session;
  const tabId = Number(saved.affiliate_search_tab_id);
  if (!session?.candidate_id || !Number.isInteger(tabId)) throw new Error('Không còn phiên tìm chương trình affiliate.');
  const tab = await chrome.tabs.get(tabId);
  const url = new URL(String(tab.url || ''));
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.hostname === 'www.google.com'
      || isHiAutoUrl(url.href)) {
    throw new Error('Hãy mở trang đăng ký Affiliate/Partner từ kết quả Google trước.');
  }
  const originPattern = `${url.origin}/*`;
  if (!await chrome.permissions.contains({ origins: [originPattern] })) {
    throw new Error(`Chrome chưa cấp quyền đọc ${url.hostname}. Hãy bấm lại nút Quét & điền.`);
  }
  const profileId = Number(message.profile_id);
  if (!Number.isInteger(profileId) || profileId <= 0) throw new Error('Hãy chọn hồ sơ cần dùng.');
  const job = await api('/api/ads-miner/affiliate-helper/jobs', {
    method: 'POST', body: {
      candidate_id: Number(session.candidate_id), application_url: url.href,
      profile_id: profileId, variant_id: message.variant_id ? Number(message.variant_id) : null,
    },
  });
  await chrome.storage.session.set({
    affiliate_application_command: job,
    affiliate_application_tab_id: tabId,
    affiliate_application_frame_id: 0,
    affiliate_application_frame_score: -1,
    affiliate_application_frame_seen_at: Date.now(),
    affiliate_popup_allowed_origins: [],
    affiliate_fill_plan: null,
    affiliate_ai_suggestions: [],
    affiliate_auto_fill_pending: true,
    affiliate_search_session: { ...session, stage: 'scanning_form', application_url: url.href,
      profile_id: profileId },
  });
  await injectAffiliateForm(tabId);
  await chrome.tabs.update(tabId, { active: true });
  notifyPanel({ log: `Đang quét và điền form ${job.brand_name} bằng hồ sơ đã chọn.`, kind: 'ok' });
  return { message: `Đang quét và điền form trên ${url.hostname}.`, job, tab_id: tabId };
}

const reportProgress = (payload) => api('/api/ads-miner/discovery/helper/job/progress', { method: 'POST', body: payload });

async function openLegacyWorkTab(url, purpose) {
  if (!allowedNavigation(url, purpose)) throw new Error(`Navigation rejected for ${purpose}.`);
  const saved = await savedState(); let tab = null;
  if (saved.work_tab_id) {
    try {
      const current = await chrome.tabs.get(saved.work_tab_id);
      tab = await chrome.tabs.update(saved.work_tab_id, { url, active: true });
      // Updating a tab to the exact same URL may keep the same document, so a newly stored command would never
      // reach the content script. A real reload is the compatibility fallback for an old/missing listener.
      if (new URL(current.url).href === new URL(url).href) {
        await chrome.tabs.reload(saved.work_tab_id);
        tab = await chrome.tabs.get(saved.work_tab_id);
      }
    } catch { /* User removed it. */ }
  }
  if (!tab) tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.session.set({ work_tab_id: tab.id });
  return tab;
}

async function closeLegacyWorkTab(tabId) {
  const candidate = Number(tabId);
  if (!Number.isInteger(candidate)) return { closing: false, reason: 'invalid_tab' };
  const saved = await savedState();
  if (Number(saved.work_tab_id) !== candidate) return { closing: false, reason: 'not_tracked' };
  if (Number(saved.local_tab_id) === candidate) return { closing: false, reason: 'hi_auto_tab' };
  if (saved.tab_registry && canCloseOwnedTab(saved.tab_registry, candidate)) {
    return { closing: false, reason: 'automatic_job_owns_tab' };
  }
  await chrome.storage.session.remove(['work_tab_id']);
  // Let the content script receive its final ACK before removing its document.
  setTimeout(() => chrome.tabs.remove(candidate).catch(() => {}), 250);
  return { closing: true };
}

async function createControllerTab(job) {
  const saved = await savedState();
  if (!allowedNavigation('https://valentin.app/', 'valentin')) throw new Error('Valentin navigation rejected.');
  const tab = await chrome.tabs.create({ url: 'https://valentin.app/', active: true });
  let registry = createOwnedTabRegistry(job.job_id, saved.local_tab_id);
  registry = registerCreatedTab(registry, 'controller', tab.id);
  await chrome.storage.session.set({ tab_registry: registry, work_tab_id: tab.id });
  return tab;
}

async function navigateOwnedTab(tabId, url, purpose, jobId) {
  if (!allowedNavigation(url, purpose)) throw new Error(`Navigation rejected for ${purpose}.`);
  const saved = await savedState(); const registry = saved.tab_registry;
  if (!registry || registry.job_id !== jobId || !canCloseOwnedTab(registry, tabId)) {
    throw new Error('Refusing to navigate a tab not created by this job.');
  }
  return chrome.tabs.update(Number(tabId), { url, active: true });
}

async function reusableController(jobId) {
  const { tab_registry: registry } = await savedState();
  if (!registry || registry.job_id !== jobId) throw new Error('Owned tab registry is missing.');
  for (const tabId of [registry.controller_tab_id, registry.serp_tab_id]) {
    if (!canCloseOwnedTab(registry, tabId)) continue;
    try { await chrome.tabs.get(Number(tabId)); return Number(tabId); } catch { /* User already closed it. */ }
  }
  throw new Error('Both job-owned temporary tabs were closed.');
}

async function ensureResumeController(jobId) {
  try { return await reusableController(jobId); } catch { /* Previous terminal cleanup may have removed it. */ }
  const saved = await savedState();
  if (!saved.local_tab_id) throw new Error('Open Hi Auto and reconnect Browser Helper before resume.');
  const tab = await chrome.tabs.create({ url: ADS_TRANSPARENCY_ROOT, active: true });
  let registry = createOwnedTabRegistry(jobId, saved.local_tab_id);
  registry = registerCreatedTab(registry, 'controller', tab.id);
  await chrome.storage.session.set({ tab_registry: registry, work_tab_id: tab.id });
  return tab.id;
}

async function cleanupOwnedTabs(jobId) {
  const saved = await savedState(); const registry = saved.tab_registry;
  if (!registry || registry.job_id !== jobId) return { warnings: [] };
  const warnings = [];
  for (const tabId of ownedTemporaryTabIds(registry)) {
    if (!canCloseOwnedTab(registry, tabId)) continue;
    try { await chrome.tabs.remove(tabId); } catch (error) {
      if (!/No tab with id|Invalid tab ID/i.test(error?.message ?? '')) warnings.push(`tab ${tabId}: ${error.message}`);
    }
  }
  await chrome.storage.session.remove([
    'tab_registry', 'work_tab_id', 'active_job', 'advertiser_command',
    'catcher_research_command', 'portfolio_command', 'serp_registration',
  ]);
  return { warnings };
}

async function notifyUi(detail = {}) {
  const saved = await savedState();
  if (!saved.local_tab_id) return;
  try { await chrome.tabs.sendMessage(saved.local_tab_id, { type: 'DISCOVERY_DATA_UPDATED', ...detail }); } catch { /* UI polling remains the fallback. */ }
}

async function finishAndCleanup(jobId) {
  const terminal = await api('/api/ads-miner/discovery/helper/job/begin-cleanup', { method: 'POST', body: { job_id: jobId } });
  await chrome.storage.session.set({ active_job: terminal });
  const cleanup = await cleanupOwnedTabs(jobId);
  const completed = await api('/api/ads-miner/discovery/helper/job/cleanup-complete', {
    method: 'POST', body: { job_id: jobId, cleanup_warning: cleanup.warnings.join('; ') || null },
  });
  await notifyUi();
  return completed;
}

async function startNextAdvertiser(jobId, resume = false) {
  if (resume) await ensureResumeController(jobId);
  const next = await api('/api/ads-miner/discovery/helper/job/advertiser-next', {
    method: 'POST', body: { job_id: jobId, resume },
  });
  if (next.done) return finishAndCleanup(jobId);
  const command = {
    job_id: jobId, session_id: next.catcher.session_id,
    catcher_run_id: next.catcher.run_id, source_catcher_id: next.catcher.catcher_id,
    domain: next.catcher.domain, keyword: next.catcher.query,
    index: next.catcher.index, total: next.job.advertiser_total,
    requested_at: Date.now(), automatic: true,
    filter_url: adsTransparencyDomainUrl(next.catcher.domain),
  };
  await chrome.storage.session.set({ advertiser_command: command, active_job: next.job });
  const tabId = await reusableController(jobId);
  if (resume) {
    try {
      const tab = await chrome.tabs.get(tabId); const current = new URL(tab.url);
      if (current.href === command.filter_url) {
        const continued = await chrome.tabs.sendMessage(tabId, { type: 'RESUME_AUTOMATIC_ADVERTISER' });
        if (continued?.ok) { await notifyUi(); return { ok: true, command, resumed_in_place: true }; }
      }
    } catch { /* Old content scripts or unusable SPA state fall back to one safe root navigation. */ }
  }
  await navigateOwnedTab(tabId, command.filter_url, 'transparency', jobId);
  await notifyUi();
  return { ok: true, command };
}

async function advanceAdvertiserAfterPacing(jobId) {
  await notifyUi();
  await wait(ADVERTISER_DOMAIN_DELAY_MS);
  return startNextAdvertiser(jobId, false);
}

async function finishCatcher(command, result) {
  let recorded = result;
  if (result.status !== 'advertiser_found') {
    recorded = await api('/api/ads-miner/discovery/helper/job/advertiser-result', {
      method: 'POST', body: {
        job_id: command.job_id, catcher_run_id: command.catcher_run_id,
        status: result.status, advertiser_id: result.advertiser_id ?? null,
        error_code: result.error_code ?? result.status,
        error_message: result.error_message ?? null, evidence: result.evidence ?? {},
      },
    });
  }
  await chrome.storage.session.remove(['advertiser_command']);
  await notifyUi();
  if (recorded?.paused || recorded?.run_result?.paused) return { ok: true, paused: true };
  return advanceAdvertiserAfterPacing(command.job_id);
}

async function waitForInflight(jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while ((inFlightWrites.get(jobId) ?? 0) > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (inFlightWrites.get(jobId) ?? 0) === 0;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    frameCache.clearTab(tabId);
    affiliateInjectedTabs.delete(Number(tabId));
  }
  if (changeInfo.url) harvester.captureUrl(tabId, changeInfo.url).catch(() => {});
  // Bật Side Panel sẵn cho tab Hi Auto. Chrome không cho mở panel khi chưa có cử chỉ
  // người dùng, nên đây chỉ là bật sẵn; content script sẽ mở ở tương tác đầu tiên.
  if (changeInfo.url && isHiAutoUrl(changeInfo.url)) {
    enablePanelForTab(tabId).catch(() => {});
    chrome.action?.setBadgeText?.({ tabId: Number(tabId), text: '' }).catch(() => {});
  }
  if (changeInfo.status === 'complete') {
    finishDomainVerification(tabId).catch(() => {});
    adoptAffiliatePopupTab(tabId).then((adopted) => {
      if (!adopted) return injectAffiliateForm(tabId);
      return null;
    }).catch(() => {});
    harvester.reinjectIfActive(tabId).catch(() => {});
  }
});
chrome.tabs.onCreated.addListener((tab) => {
  harvester.attachChild(tab).catch(() => {});
  // Một số kết quả Google mở tab con. Chuyển phiên Affiliate sang tab đó để Panel vẫn theo đúng link người dùng chọn.
  savedState().then((saved) => {
    if (saved.affiliate_application_command?.job_id
        && Number(tab.openerTabId) === Number(saved.affiliate_application_tab_id)) {
      return chrome.storage.session.set({ affiliate_popup_candidate_tab_id: tab.id });
    }
    if (!saved.affiliate_application_command && saved.affiliate_search_session
        && Number(tab.openerTabId) === Number(saved.affiliate_search_tab_id)) {
      return chrome.storage.session.set({ affiliate_search_tab_id: tab.id });
    }
    return null;
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  frameCache.removeTab(tabId);
  affiliateInjectedTabs.delete(Number(tabId));
  await harvester.stop(tabId).catch(() => {});
  const saved = await savedState();
  if (saved.local_tab_id === tabId) await chrome.storage.session.remove(['local_tab_id']);
  if (saved.work_tab_id === tabId) await chrome.storage.session.remove(['work_tab_id']);
  // Tab làm việc của Coupon Discovery bị đóng: bỏ id chết đi để bước sau mở tab mới thay vì lỗi.
  if (saved.coupon_tab_id === tabId) {
    await chrome.storage.session.remove(['coupon_tab_id']);
    notifyPanel({ log: 'Tab làm việc đã bị đóng — bước kế tiếp sẽ mở tab mới.', kind: 'error' });
  }
  if (saved.keyword_planner_tab_id === tabId) {
    await chrome.storage.session.remove(['keyword_planner_tab_id']);
    if (saved.keyword_planner_command?.job_id) {
      await api(`/api/demand/helper/jobs/${saved.keyword_planner_command.job_id}/progress`, {
        method: 'POST', body: { status: 'needs_user', stage: 'tab_closed', error_code: 'TAB_CLOSED',
          error_message: 'Tab Keyword Planner đã bị đóng.' },
      }).catch(() => {});
    }
  }
  if (saved.affiliate_application_tab_id === tabId) {
    await chrome.storage.session.remove(['affiliate_application_tab_id', 'affiliate_application_frame_id',
      'affiliate_application_frame_score', 'affiliate_application_frame_seen_at',
      'affiliate_popup_allowed_origins']);
    if (saved.affiliate_application_command?.job_id) {
      await api(`/api/ads-miner/affiliate-helper/helper/jobs/${saved.affiliate_application_command.job_id}/progress`, {
        method: 'POST', body: { status: 'needs_user', stage: 'tab_closed', error_code: 'TAB_CLOSED',
          error_message: 'Tab đăng ký affiliate đã bị đóng trước khi đánh dấu hoàn tất.' },
      }).catch(() => {});
    }
  }
  if (saved.affiliate_popup_candidate_tab_id === tabId) {
    await chrome.storage.session.remove(['affiliate_popup_candidate_tab_id']);
  }
  if (saved.affiliate_search_tab_id === tabId) {
    await chrome.storage.session.remove(['affiliate_search_session', 'affiliate_search_root_tab_id',
      'affiliate_search_tab_id', 'affiliate_auto_fill_pending']);
  } else if (saved.affiliate_search_root_tab_id === tabId) {
    await chrome.storage.session.remove(['affiliate_search_root_tab_id']);
  }
});

chrome.downloads.onCreated.addListener(async (item) => {
  const saved = await savedState();
  const command = saved.keyword_planner_command;
  if (!command?.job_id || !['waiting_download', 'ready_for_manual_download'].includes(command.stage)
      || Date.now() - Number(command.requested_at || 0) > 30 * 60 * 1000) return;
  if (!/\.(?:csv|tsv|txt)(?:$|\?)/i.test(item.filename || item.url || '')) return;
  await chrome.storage.session.set({ keyword_planner_download_id: item.id });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== 'complete') return;
  const saved = await savedState();
  if (Number(saved.keyword_planner_download_id) !== Number(delta.id)) return;
  await finishKeywordPlannerDownload(delta.id);
});

// Kiểm tra bản mới trên GitHub Releases. 6 giờ một lần: GitHub cho 60 request/giờ
// theo IP khi không đăng nhập, nhịp này an toàn kể cả nhiều máy chung một IP văn phòng.
async function runUpdateCheck() {
  const current = chrome.runtime.getManifest().version;
  const info = await checkForUpdate(current);
  await chrome.storage.local.set({
    update_info: { ...info, checked_at: new Date().toISOString() },
  });
  if (info.ok && info.hasUpdate) {
    await chrome.action?.setBadgeBackgroundColor?.({ color: '#d93025' }).catch(() => {});
    await chrome.action?.setBadgeText?.({ text: 'NEW' }).catch(() => {});
    notifyPanel({
      kind: 'update', level: 'warn',
      log: `Có bản mới ${info.latest} (đang chạy ${current}). Tải: ${info.download_url}`,
    });
  } else if (info.ok) {
    await chrome.action?.setBadgeText?.({ text: '' }).catch(() => {});
  }
  return info;
}

async function installUpdateWatchdog() {
  await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_CHECK_MINUTES });
  runUpdateCheck().catch(() => {});
}

// Side Panel là trung tâm điều khiển: bấm icon extension mở panel thay vì popup.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch(() => { /* Chrome cũ chưa có sidePanel — các luồng còn lại vẫn chạy bình thường. */ });

chrome.runtime.onInstalled.addListener(() => {
  rehydrateHiAutoBridges().catch(() => {});
  refreshAdsTransparencyContentScripts().catch(() => {});
  installTrafficWatchdog().catch(() => {});
  installAgentJobWatchdog().catch(() => {});
  installUpdateWatchdog().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  rehydrateHiAutoBridges().catch(() => {});
  installTrafficWatchdog().catch(() => {});
  installAgentJobWatchdog().catch(() => {});
  installUpdateWatchdog().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TRAFFIC_AUTO_ALARM) resumeTrafficAuto().catch(() => {});
  if (alarm.name === AGENT_JOB_ALARM) pollAgentJob().catch(() => {});
  if (alarm.name === UPDATE_ALARM) runUpdateCheck().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'HARVESTER_OCR_IMAGE') return false;
  (async () => {
    if (message.type === 'CHECK_FOR_UPDATE') return runUpdateCheck();
    if (message.type === 'GET_UPDATE_INFO') {
      const saved = await chrome.storage.local.get('update_info');
      return saved.update_info ?? { ok: false, error: 'chua_kiem_tra' };
    }
    if (message.type === 'HARVESTER_OCR_REQUEST') return runHarvesterOcr(message, sender);
    if (message.type === 'PORTFOLIO_OCR_REQUEST') return runPortfolioOcr(message, sender);
    if (message.type === 'PORTFOLIO_OCR_BATCH_START') return startPortfolioOcrBatch(message, sender);
    if (message.type === 'PORTFOLIO_OCR_BATCH_STATUS') return portfolioOcrBatchStatus(message, sender);
    if (message.type === 'PORTFOLIO_OCR_BATCH_CANCEL') return cancelPortfolioOcrBatch(message, sender);
    if (message.type === 'PORTFOLIO_OCR_BATCH_SYNCED') return syncPortfolioOcrBatch(message, sender);
    if (message.type === 'HARVESTER_CANDIDATES') {
      const result = await harvester.receive(message, sender);
      if (result.jobId && (result.accepted || result.review)) {
        coupon.setPaused(false).then(() => coupon.driveQueue()).then(() => notifyPanel({})).catch(() => {});
      }
      return result;
    }
    if (message.type === 'HARVESTER_OPEN_PANEL') { await harvester.openPanel(sender.tab?.id); return { opened: true }; }
    if (message.type === 'HARVESTER_SAVE_RULE') return { rule: await harvester.saveRule(message.rule), message: 'Đã học vùng chứa coupon cho domain này.' };
    if (message.type === 'HARVESTER_RULE_STALE') { await harvester.staleRule(message.rule_id, message.reason); return { stale: true }; }
    if (message.type === 'HARVESTER_START') {
      const tabId = Number(message.tab_id ?? sender.tab?.id);
      if (!Number.isInteger(tabId)) throw new Error('Không tìm thấy tab để bật Coupon Harvester.');
      const session = await harvester.start(tabId, { jobId: message.job_id ?? null });
      return { session, message: 'Đã bật thu thập coupon trên tab hiện tại.' };
    }
    if (message.type === 'HARVESTER_STOP') { await harvester.stop(Number(message.tab_id)); return { message: 'Đã tắt phiên thu thập trên tab.' }; }
    if (message.type === 'HARVESTER_GET_STATE') return { harvester: await harvester.state({
      hostname: message.hostname ?? null, jobId: message.job_id ?? null,
    }) };
    if (message.type === 'HARVESTER_UPDATE_SETTINGS') return { settings: await harvester.updateSettings(message.settings), message: 'Đã lưu cấu hình Coupon Harvester.' };
    if (message.type === 'HARVESTER_VERIFY') { await harvester.verifyCoupon(message.id, message.verified !== false); return { message: 'Đã cập nhật mã.' }; }
    if (message.type === 'HARVESTER_DELETE_RULE') { await harvester.deleteRule(message.rule_id); return { message: 'Đã xóa rule đã học.' }; }
    if (message.type === 'HARVESTER_CLEAR') { await harvester.clear(); return { message: 'Đã xóa dữ liệu Coupon Harvester trên máy.' }; }
    if (message.type === 'HARVESTER_EXPORT') return { export: await harvester.exportData(message.format) };
    if (message.type === 'HARVESTER_PICKER') {
      await chrome.tabs.sendMessage(Number(message.tab_id), { type: 'HARVESTER_PICKER', enabled: true });
      return { message: 'Picker đang bật: hãy click đúng phần tử chứa mã coupon.' };
    }
    if (message.type === 'PROBE_DISCOVERY_HELPER') {
      if (!isHiAutoUrl(sender.tab?.url)) throw new Error('Probe must originate from the approved Hi Auto origin.');
      return { ok: true, version: HELPER_VERSION };
    }
    if (message.type === 'SET_HELPER_CONTEXT') {
      if (!sender.tab?.id || !isHiAutoUrl(sender.tab?.url)) {
        throw new Error('Helper context must originate from Hi Auto.');
      }
      const mode = String(message.mode || 'overview');
      if (!['overview', 'ads', 'traffic', 'coupon', 'affiliate', 'harvester'].includes(mode)) {
        throw new Error('Helper context is invalid.');
      }
      const context = { mode, route: String(message.route || '').slice(0, 180),
        label: String(message.label || '').slice(0, 100), source: 'hi_auto', updated_at: Date.now() };
      await chrome.storage.session.set({ helper_context: context });
      notifyPanel({ kind: 'context' });
      return { context };
    }
    if (message.type === 'SET_HELPER_VIEW') {
      const mode = String(message.mode || 'overview');
      if (!['overview', 'ads', 'traffic', 'coupon', 'affiliate', 'harvester'].includes(mode)) {
        throw new Error('Helper view is invalid.');
      }
      const context = { mode, route: '', label: '', source: 'panel', updated_at: Date.now() };
      await chrome.storage.session.set({ helper_context: context });
      return { context, message: `Đã chuyển sang ${mode}.` };
    }
    if (message.type === 'PAIR_LOCAL_AGENT') return pairAgent(message.code);
    if (message.type === 'REPAIR_HI_AUTO_CONNECTION') return repairHiAutoConnection();
    if (message.type === 'OPEN_HELPER_PANEL') {
      if (!sender.tab?.id || !isHiAutoUrl(sender.tab?.url)) {
        throw new Error('Side Panel chỉ được mở từ Hi Auto.');
      }
      if (!chrome.sidePanel?.open) throw new Error('Chrome hiện tại chưa hỗ trợ Side Panel.');
      // Mở theo cửa sổ để Panel không biến mất khi nhiệm vụ chuyển từ tab Hi Auto sang Google rồi sang form.
      const openFor = Number.isInteger(sender.tab.windowId)
        ? { windowId: sender.tab.windowId } : { tabId: sender.tab.id };
      await chrome.sidePanel.open(openFor);
      return { opened: true };
    }
    if (message.type === 'ADS_FRAME_SNAPSHOT') {
      const checked = validateFrameSnapshotMessage(message, sender);
      if (!checked.accepted) throw new Error(`Frame snapshot rejected: ${checked.reason}`);
      return { ok: true, ...frameCache.accept(sender.tab.id, checked.snapshot) };
    }
    if (message.type === 'GET_ADS_FRAME_SNAPSHOTS') {
      const currentUrl = String(message.profile_url ?? sender.tab?.url ?? '');
      if (!sender.tab?.id || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '') || currentUrl !== sender.tab.url) throw new Error('Frame snapshots are only available to the current Ads Transparency profile');
      return { snapshots: frameCache.get(sender.tab.id, currentUrl) };
    }
    if (message.type === 'CLEAR_ADS_FRAME_CACHE') {
      if (!sender.tab?.id || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) throw new Error('Only Ads Transparency may clear its frame cache');
      frameCache.clearTab(sender.tab.id); return { ok: true };
    }
    if (message.type === 'SET_DISCOVERY_AUTH') {
      const localTabId = sender.tab?.id ?? null;
      if (!localTabId || !isHiAutoUrl(sender.tab?.url)) throw new Error('Pairing must start from the approved Hi Auto tab.');
      frameCache.setAuth({ token: message.token, session_id: message.session_id });
      await chrome.storage.session.set({ helper_token: message.token, helper_expires_at: message.expires_at, session_id: message.session_id, local_tab_id: localTabId });
      return { ok: true, version: HELPER_VERSION };
    }
    if (message.type === 'START_DISCOVERY_JOB') {
      const saved = await savedState(); const identity = validateJobIdentity(message.job, { session_id: saved.session_id });
      if (!identity.valid) throw new Error(`Discovery job rejected: ${identity.reason}`);
      if (saved.active_job && saved.active_job.job_id !== message.job.job_id && validateJobIdentity(saved.active_job).valid) throw new Error('Browser Helper already has another active Discovery job.');
      await chrome.storage.session.set({ active_job: message.job });
      await reportProgress({ job_id: message.job.job_id, status: 'running', stage: 'opening_market', current_serp_page: 0 });
      try { await createControllerTab(message.job); } catch (error) {
        await reportProgress({ job_id: message.job.job_id, status: 'disconnected', stage: 'opening_market', current_serp_page: 0, error_code: 'disconnected', error_message: error.message });
        throw error;
      }
      return { ok: true, job_id: message.job.job_id };
    }
    if (message.type === 'REGISTER_SERP_TAB') {
      const saved = await savedState(); const registry = saved.tab_registry;
      const senderUrl = String(sender.tab?.url ?? ''); const sourceUrl = String(message.source_url ?? '');
      if (!registry || registry.job_id !== message.job_id || !allowedNavigation(senderUrl, 'serp')
          || !allowedNavigation(sourceUrl, 'serp') || senderUrl !== sourceUrl
          || !String(message.document_id ?? '').trim() || !Number.isInteger(Number(message.page_number))) {
        throw new Error('SERP tab registration rejected.');
      }
      const context = await api('/api/ads-miner/discovery/helper/job'); const freshJob = context.job;
      if (!freshJob || freshJob.job_id !== message.job_id) throw new Error('SERP tab registration rejected: job mismatch.');
      const decision = serpRegistrationDecision(registry, freshJob, sender.tab.id);
      if (decision.action === 'reject') throw new Error(`SERP tab registration rejected: ${decision.reason}.`);
      if (decision.action === 'stale') {
        return { ok: true, ignored: true, stale: true, reason: 'serp_collection_already_completed' };
      }
      const claimed = claimSerpTab(registry, { tab_id: sender.tab.id, opener_tab_id: sender.tab.openerTabId });
      if (!claimed.accepted) throw new Error(`SERP tab registration rejected: ${claimed.reason}`);
      const registration = {
        job_id: message.job_id, tab_id: sender.tab.id, document_id: message.document_id,
        page_number: Number(message.page_number), source_url: sourceUrl,
      };
      const duplicate = saved.serp_registration
        && Object.entries(registration).every(([key, value]) => saved.serp_registration[key] === value);
      await chrome.storage.session.set({ tab_registry: claimed.registry, serp_registration: registration });
      return { ok: true, idempotent: Boolean(duplicate), registered: true };
    }
    if (message.type === 'STOP_DISCOVERY_JOB') {
      const saved = await savedState(); const jobId = saved.active_job?.job_id;
      if (jobId && message.job_id && jobId !== message.job_id) throw new Error('Stop job identity mismatch.');
      if (jobId) {
        const drained = await waitForInflight(jobId);
        const context = await api('/api/ads-miner/discovery/helper/job');
        try { await reportProgress({ job_id: jobId, status: 'stopped', stage: 'stopped', current_serp_page: context.job?.current_serp_page ?? 0, error_code: drained ? null : 'persist_timeout', error_message: drained ? null : 'Timed out waiting for the current batch ACK.' }); } catch { /* Backend may already be terminal. */ }
        await cleanupOwnedTabs(jobId); await notifyUi();
      }
      return { ok: true };
    }
    if (message.type === 'SAVE_SERP_PAGE') {
      const jobId = String(message.payload?.job_id || '');
      inFlightWrites.set(jobId, (inFlightWrites.get(jobId) ?? 0) + 1);
      try {
        return await apiWithRetry(`/api/ads-miner/discovery/helper/serp-pages/${message.page_number}`, { method: 'POST', body: message.payload }, 3);
      } finally {
        inFlightWrites.set(jobId, Math.max(0, (inFlightWrites.get(jobId) ?? 1) - 1));
      }
    }
    if (message.type === 'FINALIZE_SERP') {
      const aggregation = await apiWithRetry('/api/ads-miner/discovery/helper/job/aggregate-domains', { method: 'POST', body: { job_id: message.job_id } }, 3);
      await chrome.storage.session.set({ active_job: aggregation.job }); await notifyUi();
      const completed = await finishAndCleanup(message.job_id);
      return { ok: true, aggregation, completed };
    }
    if (message.type === 'GET_ADVERTISER_COMMAND') return { command: (await savedState()).advertiser_command ?? null };
    if (message.type === 'NAVIGATE_ADVERTISER_PROFILE') {
      const command = (await savedState()).advertiser_command;
      if (!command || command.job_id !== message.job_id) throw new Error('Advertiser command identity mismatch.');
      const profileUrl = canonicalAdvertiserProfileUrl(message.profile_url, message.advertiser_id);
      if (!validateAdvertiserProfile(profileUrl, message.advertiser_id)) throw new Error('Advertiser profile host/ID validation failed.');
      await chrome.storage.session.set({ advertiser_command: {
        ...command, advertiser_id: message.advertiser_id, profile_url: profileUrl,
        search_evidence: message.evidence ?? null,
      } });
      const tabId = await reusableController(command.job_id);
      await navigateOwnedTab(tabId, profileUrl, 'transparency', command.job_id);
      return { ok: true };
    }
    if (message.type === 'NAVIGATE_CATCHER_PROFILE') {
      const saved = await savedState();
      const command = saved.catcher_research_command;
      if (!command?.domain || !command?.session_id) throw new Error('Catcher research command is missing.');
      if (!sender.tab?.id || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) {
        throw new Error('Catcher profile navigation must originate from Ads Transparency.');
      }
      const profileUrl = canonicalAdvertiserProfileUrl(message.profile_url, message.advertiser_id);
      if (!validateAdvertiserProfile(profileUrl, message.advertiser_id)) {
        throw new Error('Invalid Ads Transparency advertiser profile.');
      }
      await chrome.storage.session.set({ catcher_research_command: {
        ...command, advertiser_id: message.advertiser_id, profile_url: profileUrl,
        search_evidence: message.evidence ?? null,
      } });
      await chrome.tabs.update(sender.tab.id, { url: profileUrl, active: true });
      return { ok: true };
    }
    if (message.type === 'SET_ADVERTISER_PROFILE_BATCH') {
      if (!sender.tab?.id || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) {
        throw new Error('Advertiser batch must originate from Ads Transparency.');
      }
      const saved = await savedState();
      const commandKey = saved.advertiser_command?.automatic
        ? 'advertiser_command' : 'catcher_research_command';
      const command = saved[commandKey];
      if (!command?.domain || !command.filter_url
          || !matchesAdsTransparencyDomainFilter(sender.tab.url, command.domain)) {
        throw new Error('Advertiser batch does not match the active domain filter.');
      }
      const profiles = sanitizeAdvertiserProfiles(message.profiles);
      if (!profiles.length) throw new Error(`Không tìm thấy profile advertiser hợp lệ cho ${command.domain}.`);
      const queued = {
        ...command, profile_queue: profiles, profile_index: 0,
        collected_advertiser_ids: [], advertiser_id: profiles[0].advertiser_id,
        profile_url: profiles[0].profile_url,
      };
      await chrome.storage.session.set({ [commandKey]: queued });
      await chrome.tabs.update(sender.tab.id, { url: profiles[0].profile_url, active: true });
      return { ok: true, count: profiles.length, advertiser_id: profiles[0].advertiser_id };
    }
    if (message.type === 'UPDATE_CATCHER_RESEARCH_SCAN') {
      if (!sender.tab?.id || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) {
        throw new Error('Manual advertiser scan must originate from Ads Transparency.');
      }
      const saved = await savedState(); const command = saved.catcher_research_command;
      if (!command?.domain || command.domain !== String(message.domain || '').toLowerCase()) {
        throw new Error('Manual advertiser scan no longer matches the active catcher.');
      }
      const manualProfiles = sanitizeAdvertiserProfiles(message.profiles);
      await chrome.storage.session.set({ catcher_research_command: {
        ...command, manual_profiles: manualProfiles, manual_scan_updated_at: Date.now(),
      } });
      return { ok: true, count: manualProfiles.length };
    }
    if (message.type === 'CONFIRM_CATCHER_RESEARCH_SCAN') {
      if (!sender.tab?.id || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) {
        throw new Error('Manual advertiser confirmation must originate from Ads Transparency.');
      }
      const saved = await savedState(); const command = saved.catcher_research_command;
      if (!command?.domain || command.domain !== String(message.domain || '').toLowerCase()
          || !command.source_catcher_id) {
        throw new Error('Manual advertiser confirmation no longer matches the selected catcher.');
      }
      const profiles = sanitizeAdvertiserProfiles(message.profiles);
      const savedIds = [];
      for (const profile of profiles) {
        const stored = await api('/api/ads-miner/discovery/helper/advertiser-profile', {
          method: 'POST', body: {
            source_domain_id: command.source_catcher_id,
            profile: {
              advertiser_id: profile.advertiser_id, profile_url: profile.profile_url,
              advertiser_name: profile.advertiser_name,
              evidence: { source: 'manual_ads_transparency_confirmation', snippet: profile.evidence },
            },
            observed_at: new Date().toISOString(),
          },
        });
        if (stored?.advertiser_id) savedIds.push(stored.advertiser_id);
      }
      await chrome.storage.session.remove(['catcher_research_command']);
      const notice = `Đã xác nhận ${savedIds.length} advertiser từ ${command.domain}. Xem tại tab Đối thủ quảng cáo.`;
      await notifyUi({ notice, manual_catcher_result: {
        domain: command.domain, found_count: profiles.length, saved_count: savedIds.length,
        advertiser_ids: savedIds,
      } });
      return { ok: true, found_count: profiles.length, saved_count: savedIds.length,
        advertiser_ids: savedIds, tab_kept_open: true };
    }
    if (message.type === 'ADVERTISER_BATCH_PROFILE_SAVED') {
      if (!sender.tab?.id || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) {
        throw new Error('Advertiser batch ACK must originate from Ads Transparency.');
      }
      const saved = await savedState();
      const automatic = Boolean(saved.advertiser_command?.automatic);
      const commandKey = automatic ? 'advertiser_command' : 'catcher_research_command';
      const command = saved[commandKey];
      const queue = Array.isArray(command?.profile_queue) ? command.profile_queue : [];
      const index = Number(command?.profile_index) || 0;
      const expected = queue[index];
      if (!expected || expected.advertiser_id !== message.advertiser_id
          || !validateAdvertiserProfile(sender.tab.url, expected.advertiser_id)) {
        throw new Error('Saved advertiser does not match the active batch item.');
      }
      const collected = [...new Set([
        ...(command.collected_advertiser_ids ?? []), expected.advertiser_id,
      ])];
      const next = queue[index + 1];
      if (next) {
        await chrome.storage.session.set({ [commandKey]: {
          ...command, profile_index: index + 1, collected_advertiser_ids: collected,
          advertiser_id: next.advertiser_id, profile_url: next.profile_url,
        } });
        await wait(ADVERTISER_PROFILE_DELAY_MS);
        await chrome.tabs.update(sender.tab.id, { url: next.profile_url, active: true });
        return { ok: true, done: false, index: index + 2, total: queue.length };
      }
      if (automatic) {
        const recorded = await api('/api/ads-miner/discovery/helper/job/advertiser-result', {
          method: 'POST', body: {
            job_id: command.job_id, catcher_run_id: command.catcher_run_id,
            status: 'advertiser_found', advertiser_id: collected[0],
            evidence: { advertiser_ids: collected, profile_count: collected.length,
              filter_url: command.filter_url, source: 'ads_transparency_domain_filter' },
          },
        });
        await chrome.storage.session.remove(['advertiser_command']);
        await notifyUi();
        const advanced = recorded?.paused
          ? { ok: true, paused: true }
          : await advanceAdvertiserAfterPacing(command.job_id);
        return { ...advanced, done: true, total: collected.length };
      }
      await chrome.storage.session.remove(['catcher_research_command']);
      await notifyUi();
      const close = await closeLegacyWorkTab(sender.tab.id);
      return { ok: true, done: true, total: collected.length, ...close };
    }
    if (message.type === 'ADVERTISER_CATCHER_FINISHED') {
      const command = (await savedState()).advertiser_command;
      if (!command || command.job_id !== message.job_id || command.catcher_run_id !== message.catcher_run_id) throw new Error('Advertiser result identity mismatch.');
      return finishCatcher(command, message.result ?? {});
    }
    if (message.type === 'RESUME_ADVERTISER_DISCOVERY') {
      const saved = await savedState(); const jobId = message.job_id || saved.active_job?.job_id;
      if (!jobId) throw new Error('No advertiser discovery job is available to resume.');
      return startNextAdvertiser(jobId, true);
    }
    if (message.type === 'START_ADVERTISER_COLLECTION') {
      const rawTarget = String(message.profile_url || '');
      const target = withAnywhereRegion(rawTarget);
      if (!rawTarget || !allowedNavigation(target, 'transparency')
          || !validateAdvertiserProfile(target, message.advertiser_id)) {
        throw new Error('Invalid Ads Transparency advertiser profile.');
      }
      const auth = await savedState();
      if (!message.session_id || message.session_id !== auth.session_id) {
        throw new Error('Portfolio collection session does not match the paired Hi Auto session.');
      }
      const sourceDomain = String(message.source_domain || '').trim().toLowerCase();
      const helperContext = await api('/api/ads-miner/discovery/helper/session');
      if (!sourceDomain || helperContext.selected_source_domain?.hostname !== sourceDomain
          || !helperContext.selected_source_domain_id) {
        throw new Error('Portfolio source domain does not match the selected Hi Auto catcher.');
      }
      await chrome.storage.session.set({ portfolio_command: {
        advertiser_id: message.advertiser_id, profile_url: target,
        session_id: message.session_id, requested_at: Date.now(),
        source_domain: sourceDomain,
        source_catcher_id: helperContext.selected_source_domain_id,
        manual_creatives: [], manual_profile: null, manual_observations: 0,
        manual_filter_urls: [target], manual_snapshot_taken: false,
      } });
      await openLegacyWorkTab(target, 'transparency'); return { ok: true };
    }
    if (message.type === 'UPDATE_PORTFOLIO_SCAN') {
      if (!sender.tab?.id || !validateAdvertiserProfile(sender.tab.url, message.advertiser_id)) {
        throw new Error('Manual portfolio scan must originate from the selected advertiser profile.');
      }
      const saved = await savedState(); const command = saved.portfolio_command;
      if (!command || command.advertiser_id !== message.advertiser_id) {
        throw new Error('Manual portfolio scan no longer matches the active advertiser.');
      }
      const manualCreatives = (Array.isArray(message.creatives) ? message.creatives : [])
        .filter((item) => /^CR\d+$/.test(String(item?.creative_external_id || item?.creative_id || item?.id || '')))
        .slice(0, 5000);
      const manualProfile = message.profile?.advertiser_id === command.advertiser_id
        ? message.profile : command.manual_profile;
      await chrome.storage.session.set({ portfolio_command: {
        ...command, manual_creatives: manualCreatives, manual_profile: manualProfile,
        manual_observations: Math.max(0, Number(message.observations) || 0),
        manual_snapshot_taken: Boolean(message.snapshot_taken),
        manual_filter_urls: (Array.isArray(message.filter_urls) ? message.filter_urls : [])
          .filter((value) => /^https:\/\/adstransparency\.google\.com\//i.test(String(value || ''))).slice(0, 50),
        manual_scan_updated_at: Date.now(),
      } });
      return { ok: true, creative_count: manualCreatives.length };
    }
    if (message.type === 'CONFIRM_PORTFOLIO_SCAN') {
      if (!sender.tab?.id || !validateAdvertiserProfile(sender.tab.url, message.advertiser_id)) {
        throw new Error('Manual portfolio confirmation must originate from the selected advertiser profile.');
      }
      const saved = await savedState(); const command = saved.portfolio_command;
      if (!command || command.advertiser_id !== message.advertiser_id) {
        throw new Error('Manual portfolio confirmation no longer matches the active advertiser.');
      }
      const creativeCount = Math.max(0, Number(message.creative_count) || 0);
      const projectCount = Math.max(0, Number(message.project_count) || 0);
      const trafficReadyCount = Math.max(0, Number(message.traffic_ready_count) || 0);
      const trafficQueuedCount = Math.max(0, Number(message.traffic_queued_count) || 0);
      const handoffError = String(message.handoff_error || '').slice(0, 300);
      await chrome.storage.session.remove(['portfolio_command']);
      const notice = handoffError
        ? `Đã lưu ${creativeCount} creative · ${projectCount} dự án của ${command.advertiser_id}, nhưng chưa xếp được hàng traffic: ${handoffError}`
        : `Đã xác nhận ${creativeCount} creative · ${projectCount} dự án của ${command.advertiser_id} · ${trafficReadyCount} domain · ${trafficQueuedCount} đã xếp hàng traffic.`;
      await notifyUi({ notice, manual_portfolio_result: {
        advertiser_id: command.advertiser_id, creative_count: creativeCount,
        project_count: projectCount, traffic_ready_count: trafficReadyCount,
        traffic_queued_count: trafficQueuedCount, handoff_status: message.handoff_status ?? null,
        handoff_error: handoffError || null,
      } });
      return { ok: true, tab_kept_open: true };
    }
    if (message.type === 'CANCEL_PORTFOLIO_SCAN') {
      if (!sender.tab?.id || !validateAdvertiserProfile(sender.tab.url, message.advertiser_id)) {
        throw new Error('Manual portfolio cancellation must originate from the selected advertiser profile.');
      }
      const saved = await savedState(); const command = saved.portfolio_command;
      if (!command || command.advertiser_id !== message.advertiser_id) {
        throw new Error('Manual portfolio cancellation no longer matches the active advertiser.');
      }
      await chrome.storage.session.remove(['portfolio_command']);
      return { ok: true, tab_kept_open: true };
    }
    if (message.type === 'START_CATCHER_RESEARCH') {
      const domain = String(message.domain || '').trim().toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Invalid confirmed catcher domain.');
      const auth = await savedState();
      if (!message.session_id || message.session_id !== auth.session_id) {
        throw new Error('Catcher research session does not match the paired Hi Auto session.');
      }
      const helperContext = await api('/api/ads-miner/discovery/helper/session');
      if (helperContext.selected_source_domain?.hostname !== domain
          || !helperContext.selected_source_domain_id) {
        throw new Error('Hi Auto has not selected the requested catcher for manual advertiser research.');
      }
      const filterUrl = adsTransparencyDomainUrl(domain);
      await chrome.storage.session.set({ catcher_research_command: {
        domain, session_id: message.session_id, source_catcher_id: helperContext.selected_source_domain_id,
        requested_at: Date.now(), filter_url: filterUrl, manual_profiles: [],
      } });
      const saved = await savedState();
      if (saved.work_tab_id) {
        try {
          const tab = await chrome.tabs.get(saved.work_tab_id);
          const current = new URL(tab.url);
          if (current.href === filterUrl) {
            const continued = await chrome.tabs.sendMessage(tab.id, { type: 'RESUME_CATCHER_RESEARCH' });
            if (continued?.ok) {
              await chrome.tabs.update(tab.id, { active: true });
              return { ok: true, resumed_in_place: true };
            }
          }
        } catch { /* Missing/old content script falls through to a real navigation. */ }
      }
      await openLegacyWorkTab(filterUrl, 'transparency'); return { ok: true };
    }
    if (message.type === 'GET_DISCOVERY_SESSION') return api('/api/ads-miner/discovery/helper/session');
    if (message.type === 'GET_DISCOVERY_JOB') return api('/api/ads-miner/discovery/helper/job');
    if (message.type === 'REPORT_DISCOVERY_PROGRESS') {
      const result = await reportProgress(message.payload);
      await chrome.storage.session.set({ active_job: result }); return result;
    }
    if (message.type === 'GET_PORTFOLIO_COMMAND') return { command: (await savedState()).portfolio_command ?? null };
    if (message.type === 'CLEAR_PORTFOLIO_COMMAND') { await chrome.storage.session.remove(['portfolio_command']); return { ok: true }; }
    if (message.type === 'GET_CATCHER_RESEARCH_COMMAND') return { command: (await savedState()).catcher_research_command ?? null };
    if (message.type === 'CLEAR_CATCHER_RESEARCH_COMMAND') { await chrome.storage.session.remove(['catcher_research_command']); return { ok: true }; }
    if (message.type === 'CLOSE_LEGACY_WORK_TAB') {
      if (!sender.tab?.id || !/^https:\/\/adstransparency\.google\.com\//i.test(sender.tab.url ?? '')) {
        throw new Error('Work-tab cleanup must originate from Ads Transparency.');
      }
      return closeLegacyWorkTab(sender.tab.id);
    }
    // ── Browser Helper 2.0 ────────────────────────────────────────────────
    if (message.type === 'GET_HELPER_HANDSHAKE') {
      let local = await savedState();
      let portfolioOcrJob = local.portfolio_ocr_job ?? null;
      if (portfolioOcrJob && ['synced', 'failed', 'cancelled'].includes(portfolioOcrJob.stage)
          && Date.now() - Date.parse(portfolioOcrJob.updated_at || 0) > 24 * 60 * 60 * 1000) {
        await chrome.storage.session.remove('portfolio_ocr_job');
        portfolioOcrJob = null;
      }
      if (!local.affiliate_search_session) {
        try {
          const recovered = await recoverAffiliateApplication();
          if (recovered.recovered) local = await savedState();
        } catch { /* Recovery is best-effort; the normal Panel connection state remains usable. */ }
      }
      const initialView = helperPanelView(local, { job: local.coupon_job ?? null });
      // Không được chạm API Coupon trước khi biết người dùng đang ở module Coupon. Đây là ranh giới
      // tác vụ: Affiliate/Ads/Harvester không tải queue, candidate hay dự án coupon ở nền.
      const state = initialView === 'coupon'
        ? await coupon.currentState()
        : { job: null, recentJob: null, candidates: [], paused: Boolean(local.coupon_paused) };
      const helperView = helperPanelView(local, state);
      const visibleJob = state.job ?? (['needs_user', 'needs_login', 'paused'].includes(state.recentJob?.status)
        ? state.recentJob : null);
      let queue = null;
      if (helperView === 'coupon') {
        try {
          const listed = await api('/api/ads-miner/coupon-discovery/jobs?limit=1');
          queue = listed.queue;
        } catch { /* Chưa ghép nối — Side Panel vẫn hiển thị được phần trạng thái cục bộ. */ }
      }
      let affiliateSearch = local.affiliate_search_session ?? null;
      let affiliateProfiles = [];
      if (affiliateSearch) {
        try {
          const searchTab = await chrome.tabs.get(Number(local.affiliate_search_tab_id));
          const currentUrl = String(searchTab.url || searchTab.pendingUrl || '');
          if (!currentUrl) affiliateSearch = { ...affiliateSearch, stage: 'opening_link',
            current_url: '', current_host: '' };
          else {
            const current = new URL(currentUrl);
            const keepStage = affiliateSearch.purpose === 'domain_verification'
              && ['verifying', 'completed', 'failed'].includes(affiliateSearch.stage);
            affiliateSearch = { ...affiliateSearch, current_url: currentUrl,
              current_host: current.hostname,
              stage: keepStage ? affiliateSearch.stage
                : current.hostname === 'www.google.com' ? 'searching_google' : 'form_selected' };
          }
        } catch {
          affiliateSearch = { ...affiliateSearch, stage: 'tab_closed', current_url: '', current_host: '' };
        }
        // Khi còn ở Google, đây là bước thủ công hoàn toàn: không gọi API/pairing và không tải hồ sơ.
        // Hồ sơ chỉ cần sau khi người dùng đã mở trang đích; api() lúc đó tự sửa pairing nếu cần.
        if (affiliateSearch.stage === 'form_selected'
            && affiliateSearch.purpose !== 'domain_verification') {
          try {
            const listed = await api('/api/ads-miner/affiliate-helper/profiles');
            affiliateProfiles = listed?.items ?? [];
          } catch { /* Panel vẫn giữ đúng Affiliate UI; nút quét sẽ báo lỗi nếu Hi Auto thật sự offline. */ }
        }
        if (affiliateSearch.stage === 'form_selected'
            && affiliateSearch.purpose === 'domain_verification') {
          finishDomainVerification(Number(local.affiliate_search_tab_id)).catch(() => {});
        }
      }
      return {
        handshake: buildHandshake({
          extensionVersion: HELPER_VERSION,
          adapters: adapterRegistry.available({ url: '' }),
          connectionState: await connectionState(),
          activeJob: visibleJob,
          queue,
        }),
        queue, project_total: null, candidates: state.candidates,
        recent_job: state.recentJob, projects: [], paused: state.paused,
        keyword_planner_job: null,
        affiliate_job: local.affiliate_application_command ?? null,
        affiliate_plan: local.affiliate_fill_plan ?? null,
        affiliate_ai_suggestions: local.affiliate_ai_suggestions ?? [],
        affiliate_search: affiliateSearch?.purpose === 'domain_verification' ? null : affiliateSearch,
        domain_verification: affiliateSearch?.purpose === 'domain_verification' ? affiliateSearch : null,
        affiliate_profiles: affiliateProfiles,
        helper_view: helperView,
        helper_context: local.helper_context ?? { mode: 'overview' },
        agent_connection: {
          state: await agentConnectionState({ checkHealth: true }),
          bridge_url: AGENT_BRIDGE_URL,
          expires_at: (await agentSavedState()).expires_at || null,
        },
        ads_job: local.active_job ?? null,
        portfolio_ocr_job: portfolioOcrJob,
        traffic: helperView === 'traffic' ? await trafficState() : null,
      };
    }
    if (message.type === 'TRAFFIC_QUEUE_RUN') {
      const ids = Array.isArray(message.screening_ids)
        ? [...new Set(message.screening_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
        : [];
      const runLimit = Number.MAX_SAFE_INTEGER;
      const queued = await api('/api/trend-gate/traffic/queue', { method: 'POST', body: {
        screening_ids: ids.slice(0, TRAFFIC_BATCH_SIZE), limit: null,
      } });
      let recovered = false;
      if (!trafficDrivePromise) {
        const remoteRunning = queued?.traffic?.items?.find((item) =>
          item.status === 'running' && item.lane === 'sitedata') ?? null;
        if (remoteRunning?.traffic_job_id) {
          await api(`/api/trend-gate/traffic/helper/jobs/${remoteRunning.traffic_job_id}/retry`, { method: 'POST', body: {} });
          await chrome.storage.session.set({ traffic_job: { ...remoteRunning, status: 'queued' } });
          recovered = true;
        }
      }
      await chrome.storage.local.set({ traffic_auto_enabled: true });
      await chrome.storage.session.set({ traffic_paused: false });
      driveTrafficQueue({ maxJobs: runLimit })
        .catch((error) => notifyPanel({ log: `Traffic đã dừng an toàn: ${error.message}`, kind: 'error' }));
      const waiting = Number(queued?.traffic?.queued || 0) + (recovered ? 1 : 0);
      const messageText = recovered
        ? 'Đã khôi phục lượt kiểm bị dở và tiếp tục mở SiteData.'
        : waiting > 0 || queued.inserted > 0
          ? `Đã bật Auto SiteData (${waiting || queued.inserted} dự án đang chờ). Tab bị đóng sẽ tự mở lại.`
          : 'Không còn dự án đủ điều kiện trong hàng kiểm traffic.';
      return { message: messageText, queued, recovered };
    }
    if (message.type === 'TRAFFIC_QUEUE_PAUSE') {
      await chrome.storage.local.set({ traffic_auto_enabled: false });
      await chrome.storage.session.set({ traffic_paused: true });
      return { message: 'Sẽ dừng kiểm traffic tại checkpoint hiện tại.' };
    }
    if (message.type === 'TRAFFIC_JOB_REPASTE') {
      const saved = await savedState();
      const job = saved.traffic_job;
      if (!job?.traffic_job_id || !job?.provider_domain) {
        throw new Error('Không có domain traffic hiện tại để dán lại.');
      }
      if (job.lane !== 'sitedata') throw new Error('Domain is not in the manual SiteData lane.');
      trafficAttemptRevision += 1;
      await chrome.storage.session.set({ traffic_paused: false });
      await chrome.storage.session.remove(['traffic_next_allowed_at']);
      await setTrafficProgress(job, 'awaiting_manual_search', 'user_requested_paste');

      const existingTabId = Number(saved.traffic_tab_id);
      let tab = Number.isInteger(existingTabId)
        ? await chrome.tabs.get(existingTabId).catch(() => null) : null;
      let onHomePage = false;
      try {
        const current = new URL(String(tab?.url || tab?.pendingUrl || ''));
        onHomePage = current.origin === 'https://sitedata.dev'
          && (current.pathname === '/' || /^\/[a-z]{2}\/?$/i.test(current.pathname));
      } catch { /* Open a fresh SiteData home page below. */ }
      if (tab) tab = await chrome.tabs.update(tab.id,
        onHomePage ? { active: true } : { url: 'https://sitedata.dev/', active: true });
      else {
        tab = await chrome.tabs.create({ url: 'https://sitedata.dev/', active: true });
        await chrome.storage.session.set({ traffic_tab_id: tab.id });
      }

      if (!trafficDrivePromise) {
        if (job.status !== 'running') {
          await api(`/api/trend-gate/traffic/helper/jobs/${job.traffic_job_id}/retry`, { method: 'POST', body: {} });
          await chrome.storage.session.set({ traffic_job: { ...job, status: 'queued' } });
        }
        driveTrafficQueue().catch((error) => notifyPanel({
          log: `Traffic đã dừng an toàn: ${error.message}`, kind: 'error',
        }));
      }

      const submitted = await submitSiteDataSearch(tab.id, job.provider_domain, job);
      if (!['submitted', 'result_page'].includes(submitted.status)) {
        await setTrafficProgress(job, 'issue', submitted.reason || 'search_form_timeout');
        return { message: `Chưa chạy lại được ${job.provider_domain}; xem nguyên nhân trên panel.` };
      }
      await setTrafficProgress(job, 'awaiting_result', 'auto_search_submitted');
      return { message: `Đã chạy lại ${job.provider_domain}; đang chờ SiteData trả kết quả.` };
    }
    if (message.type === 'TRAFFIC_QUEUE_RESUME') {
      const saved = await savedState();
      if (saved.traffic_job?.traffic_job_id && saved.traffic_job?.lane === 'sitedata'
          && ['needs_user', 'quota', 'retry'].includes(saved.traffic_job.status)) {
        await api(`/api/trend-gate/traffic/helper/jobs/${saved.traffic_job.traffic_job_id}/retry`, { method: 'POST', body: {} });
      }
      await chrome.storage.local.set({ traffic_auto_enabled: true });
      await chrome.storage.session.set({ traffic_paused: false });
      resumeTrafficAuto().catch((error) => notifyPanel({ log: `Traffic đã dừng an toàn: ${error.message}`, kind: 'error' }));
      return { message: 'Đã tiếp tục Auto SiteData.' };
    }
    if (message.type === 'TRAFFIC_JOB_SKIP') {
      const saved = await savedState();
      const skippedJob = saved.traffic_job;
      if (skippedJob?.traffic_job_id && skippedJob?.lane !== 'sitedata') {
        throw new Error('Domain is not in the manual SiteData lane.');
      }
      if (skippedJob?.traffic_job_id) {
        trafficSkippedJobIds.add(Number(skippedJob.traffic_job_id));
        trafficAttemptRevision += 1;
        await setTrafficProgress(skippedJob, 'skipping', 'user_skipped');
      }
      if (!saved.traffic_job?.traffic_job_id) throw new Error('Không có dự án traffic đang chờ để bỏ qua.');
      await api(`/api/trend-gate/traffic/helper/jobs/${saved.traffic_job.traffic_job_id}/cancel`, {
        method: 'POST', body: {},
      });
      const trafficTabId = Number(saved.traffic_tab_id);
      if (Number.isInteger(trafficTabId)) {
        await chrome.tabs.update(trafficTabId, { url: 'https://sitedata.dev/', active: true }).catch(() => null);
      }
      await chrome.storage.session.set({ traffic_paused: false,
        traffic_last_result: { ...saved.traffic_job, status: 'cancelled', reason: 'user_skipped' } });
      await chrome.storage.session.remove(['traffic_job']);
      if (trafficDrivePromise) {
        return { message: 'Đã bỏ key hiện tại; domain kế tiếp đã sẵn sàng để bạn bấm Dán.' };
      }
      trafficSkippedJobIds.delete(Number(skippedJob.traffic_job_id));
      driveTrafficQueue().catch((error) => notifyPanel({ log: `Traffic đã dừng an toàn: ${error.message}`, kind: 'error' }));
      return { message: 'Đã bỏ dự án này và chuyển sang dự án traffic kế tiếp.' };
    }
    if (message.type === 'TRAFFIC_ITEM_RETRY') {
      const trafficJobId = Number(message.traffic_job_id);
      if (!Number.isInteger(trafficJobId) || trafficJobId <= 0) throw new Error('Thiếu mã lượt traffic cần quét lại.');
      const state = await trafficState();
      const item = state.items?.find((row) => Number(row.traffic_job_id) === trafficJobId);
      if (!item) throw new Error('Lượt traffic này không còn trong danh sách live.');
      if (item.lane !== 'sitedata') throw new Error('Domain is not in the manual SiteData lane.');
      if (!['needs_user', 'quota', 'retry', 'no_data'].includes(item.status)) {
        throw new Error('Chỉ quét lại dòng đang lỗi hoặc không có data.');
      }
      await api(`/api/trend-gate/traffic/helper/jobs/${trafficJobId}/retry`, { method: 'POST', body: {} });
      const saved = await savedState();
      if (Number(saved.traffic_job?.traffic_job_id) === trafficJobId) {
        trafficAttemptRevision += 1;
        await chrome.storage.session.set({ traffic_job: { ...item, status: 'queued' }, traffic_paused: false });
        const tabId = Number(saved.traffic_tab_id);
        if (Number.isInteger(tabId)) {
          // Keep the current result page. It may already contain a valid Monthly Visits
          // card even if an earlier read was fooled by a quota/rate-limit banner.
          await chrome.tabs.update(tabId, { active: true }).catch(() => null);
        }
      }
      if (!trafficDrivePromise) {
        await chrome.storage.session.set({ traffic_paused: false });
        driveTrafficQueue().catch((error) => notifyPanel({ log: `Traffic đã dừng an toàn: ${error.message}`, kind: 'error' }));
      }
      notifyPanel({ kind: 'traffic' });
      return { message: `Đã đưa ${item.provider_domain} vào hàng quét lại.` };
    }
    if (message.type === 'TRAFFIC_ITEM_SKIP') {
      const trafficJobId = Number(message.traffic_job_id);
      if (!Number.isInteger(trafficJobId) || trafficJobId <= 0) throw new Error('Thiếu mã lượt traffic cần bỏ.');
      const state = await trafficState();
      const item = state.items?.find((row) => Number(row.traffic_job_id) === trafficJobId);
      if (!item) throw new Error('Lượt traffic này không còn trong danh sách live.');
      if (item.lane !== 'sitedata') throw new Error('Domain is not in the manual SiteData lane.');
      if (!['needs_user', 'quota', 'retry', 'no_data'].includes(item.status)) {
        throw new Error('Chỉ bỏ dòng đang lỗi hoặc không có data.');
      }
      const saved = await savedState();
      if (Number(saved.traffic_job?.traffic_job_id) === trafficJobId) {
        trafficSkippedJobIds.add(trafficJobId);
        trafficAttemptRevision += 1;
      }
      await api(`/api/trend-gate/traffic/helper/jobs/${trafficJobId}/cancel`, {
        method: 'POST', body: {},
      });
      if (Number(saved.traffic_job?.traffic_job_id) === trafficJobId) {
        await chrome.storage.session.set({ traffic_last_result: { ...item, status: 'cancelled', reason: 'user_skipped' } });
        await chrome.storage.session.remove(['traffic_job']);
        if (!trafficDrivePromise) {
          await chrome.storage.session.set({ traffic_paused: false });
          driveTrafficQueue().catch((error) => notifyPanel({ log: `Traffic đã dừng an toàn: ${error.message}`, kind: 'error' }));
        }
      }
      notifyPanel({ kind: 'traffic' });
      return { message: `Đã bỏ ${item.provider_domain}.` };
    }
    if (message.type === 'GET_TRAFFIC_STATE') return { traffic: await trafficState() };
    if (message.type === 'GET_COUPON_PROJECTS') {
      const available = await api('/api/ads-miner/coupon-discovery/projects?limit=25&only=affiliate_fit&sort=third_party');
      return { projects: available?.items ?? [], project_total: available?.total ?? 0 };
    }
    if (message.type === 'GET_COUPON_COMMAND') {
      const saved = await savedState();
      const command = saved.coupon_command ?? null;
      // Chỉ trả lệnh cho đúng tab làm việc — tab khác hỏi thì không nhận được gì.
      if (!command || (saved.coupon_tab_id && sender.tab?.id && sender.tab.id !== saved.coupon_tab_id)) {
        return { command: null };
      }
      return { command };
    }
    if (message.type === 'GET_GOOGLE_SERP_MODE') {
      if (!sender.tab?.id || !/^https:\/\/www\.google\.com\/search(?:[/?#]|$)/i.test(sender.tab.url ?? '')) {
        return { mode: 'idle' };
      }
      return { mode: googleSerpMode(await savedState(), sender.tab) };
    }
    if (message.type === 'START_KEYWORD_PLANNER') {
      return { message: 'Keyword Planner đã chuyển sang CSV thủ công trong Hi Auto → Kiểm cầu (KP).' };
    }
    if (message.type === 'RESUME_KEYWORD_PLANNER_QUEUE') {
      return { message: 'Hãy upload/download CSV thủ công rồi xác nhận đồng bộ trong Hi Auto → Kiểm cầu (KP).' };
    }
    if (message.type === 'CANCEL_KEYWORD_PLANNER') {
      const saved = await savedState(); const command = saved.keyword_planner_command;
      if (!command?.job_id) throw new Error('Không có job Keyword Planner đang mở.');
      await api(`/api/demand/helper/jobs/${command.job_id}/progress`, {
        method: 'POST', body: { status: 'cancelled', stage: 'user_cancelled' },
      });
      await chrome.storage.session.remove(['keyword_planner_command', 'keyword_planner_download_id', 'keyword_planner_tab_id']);
      const tabId = Number(saved.keyword_planner_tab_id);
      if (Number.isInteger(tabId) && tabId !== Number(saved.local_tab_id)) await chrome.tabs.remove(tabId).catch(() => {});
      return { message: 'Đã huỷ file Keyword Planner hiện tại.' };
    }
    if (message.type === 'GET_KEYWORD_PLANNER_COMMAND') {
      const saved = await savedState();
      if (!saved.keyword_planner_command || (saved.keyword_planner_tab_id && sender.tab?.id
          && Number(sender.tab.id) !== Number(saved.keyword_planner_tab_id))) return { command: null };
      return { command: saved.keyword_planner_command };
    }
    if (message.type === 'KEYWORD_PLANNER_PROGRESS') {
      const saved = await savedState();
      const command = saved.keyword_planner_command;
      if (!command?.job_id || command.job_id !== message.job_id || Number(sender.tab?.id) !== Number(saved.keyword_planner_tab_id)) {
        throw new Error('Keyword Planner job/tab identity mismatch.');
      }
      const updated = await api(`/api/demand/helper/jobs/${command.job_id}/progress`, {
        method: 'POST', body: { status: message.status, stage: message.stage,
          error_code: message.error_code, error_message: message.error_message },
      });
      await chrome.storage.session.set({ keyword_planner_command: { ...command, ...updated.job } });
      return updated;
    }
    if (message.type === 'KEYWORD_PLANNER_CONTENT_ERROR') {
      const command = (await savedState()).keyword_planner_command;
      if (!command?.job_id) return { message: 'Không có job Keyword Planner đang chạy.' };
      return api(`/api/demand/helper/jobs/${command.job_id}/progress`, {
        method: 'POST', body: { status: 'needs_user', stage: 'content_error',
          error_code: 'PAGE_CHANGED', error_message: message.error_message },
      });
    }
    if (message.type === 'START_AFFILIATE_SEARCH') return startAffiliateSearch(message);
    if (message.type === 'START_DOMAIN_VERIFICATION') return startDomainVerification(message);
    if (message.type === 'RETRY_DOMAIN_VERIFICATION') {
      const saved = await savedState();
      return finishDomainVerification(Number(saved.affiliate_search_tab_id), { retry: true });
    }
    if (message.type === 'START_AFFILIATE_APPLICATION') return startAffiliateApplication(message);
    if (message.type === 'START_AFFILIATE_FROM_SEARCH') return startAffiliateFromSearch(message);
    if (message.type === 'CANCEL_AFFILIATE_SEARCH') {
      const saved = await savedState();
      const domainVerification = saved.affiliate_search_session?.purpose === 'domain_verification';
      const tabIds = [...new Set([saved.affiliate_search_root_tab_id, saved.affiliate_search_tab_id]
        .map(Number).filter((id) => Number.isInteger(id) && id !== Number(saved.local_tab_id)))];
      await chrome.storage.session.remove(['affiliate_search_session', 'affiliate_search_root_tab_id',
        'affiliate_search_tab_id', 'affiliate_auto_fill_pending']);
      if (tabIds.length) await chrome.tabs.remove(tabIds).catch(() => {});
      if (domainVerification) return { message: 'Đã kết thúc nhiệm vụ xác minh domain.' };
      return { message: 'Đã kết thúc nhiệm vụ tìm chương trình affiliate.' };
    }
    if (message.type === 'REQUEST_AFFILIATE_PERMISSION') {
      const url = new URL(String(message.application_url || ''));
      if (url.protocol !== 'https:' || !url.hostname.includes('.')) throw new Error('URL đăng ký affiliate phải là HTTPS công khai.');
      const origin = `${url.origin}/*`;
      const already = await chrome.permissions.contains({ origins: [origin] });
      const granted = already || await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(`Bạn chưa cấp quyền cho ${url.hostname}.`);
      return { granted: true, origin };
    }
    if (message.type === 'GET_AFFILIATE_APPLICATION_STATE') {
      const saved = await savedState();
      return { job: saved.affiliate_application_command ?? null, plan: saved.affiliate_fill_plan ?? null,
        tab_id: saved.affiliate_application_tab_id ?? null };
    }
    if (message.type === 'OFFLINE_FILL_START') {
      // Panel đã xin quyền origin trong cú click; ở đây chỉ xác thực tab rồi bơm scanner.
      const tabId = Number(message.tab_id);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !OFFLINE_FILLABLE_URL(tab.url)) {
        throw new Error('Tab hiện tại không điền được (cần trang HTTPS thường, không phải Google/Hi Auto).');
      }
      await chrome.storage.session.set({ offline_fill_tab_id: tabId });
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, files: ['content/affiliate-form.js'],
      });
      return { message: `Đang quét form trên ${new URL(tab.url).hostname} và điền các trường đã học…` };
    }
    if (message.type === 'OFFLINE_FILL_STATE') {
      const stored = await chrome.storage.local.get(OFFLINE_ANSWERS_KEY);
      const answers = stored[OFFLINE_ANSWERS_KEY] || [];
      return { count: answers.length, updated_at: answers[0]?.updated_at ?? null };
    }
    if (message.type === 'OFFLINE_FILL_CLEAR') {
      await chrome.storage.local.remove(OFFLINE_ANSWERS_KEY);
      await chrome.storage.session.remove('offline_fill_tab_id');
      return { message: 'Đã xoá hồ sơ điền offline. Chạy một lượt điền online để học lại.' };
    }
    if (message.type === 'RECOVER_AFFILIATE_APPLICATION') {
      const recovered = await recoverAffiliateApplication({ manual: true });
      if (!recovered.recovered) {
        if (recovered.reason === 'permission_missing') {
          return { ...recovered,
            message: `Chrome cần cấp lại quyền đọc ${new URL(recovered.permission_origin).hostname}.` };
        }
        if (recovered.reason === 'form_tab_not_found') {
          throw new Error(`Hi Auto còn nhiệm vụ ${recovered.job?.brand_name || 'Affiliate'} nhưng không thấy tab form đúng domain đang mở.`);
        }
        throw new Error('Không tìm thấy nhiệm vụ Affiliate đang làm dở trong Hi Auto.');
      }
      return recovered;
    }
    if (message.type === 'REFRESH_AFFILIATE_CURRENT_STATE') {
      const refreshed = await refreshAffiliateCurrentState();
      if (!refreshed.recovered && refreshed.reason !== 'permission_missing') {
        if (refreshed.reason === 'form_tab_not_found') {
          throw new Error(`Hi Auto còn nhiệm vụ ${refreshed.job?.brand_name || 'Affiliate'} nhưng không thấy tab form đúng domain đang mở.`);
        }
        throw new Error('Không tìm thấy nhiệm vụ Affiliate đang làm dở trong Hi Auto.');
      }
      return refreshed;
    }
    if (message.type === 'GRANT_AFFILIATE_POPUP_ACCESS') {
      const saved = await savedState();
      const allowed = new Set(saved.affiliate_fill_plan?.popup_frame_origins || []);
      const origins = [...new Set((message.origins || []).map(String))]
        .filter((origin) => allowed.has(origin));
      if (!saved.affiliate_application_command?.job_id || !origins.length) {
        throw new Error('Popup hiện tại không có iframe cần cấp quyền. Hãy quét lại hiện trạng.');
      }
      if (!await chrome.permissions.contains({ origins })) {
        throw new Error('Chrome chưa lưu quyền đọc iframe popup. Hãy bấm lại và chọn Cho phép.');
      }
      const tabId = Number(saved.affiliate_application_tab_id);
      affiliateInjectedTabs.delete(tabId);
      await chrome.storage.session.set({ affiliate_application_frame_id: 0,
        affiliate_application_frame_score: -1, affiliate_application_frame_seen_at: Date.now() });
      await injectAffiliateForm(tabId);
      return { message: 'Đã cấp quyền popup. Helper đang quét form bên trong iframe.' };
    }
    if (message.type === 'AFFILIATE_FORM_SCAN') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      // Điền OFFLINE: tab do nút "Điền form ở tab đang mở" kích hoạt, không phụ thuộc job/tool.
      const senderTabId = Number(sender.tab?.id);
      if (Number(saved.offline_fill_tab_id) === senderTabId
          && (!command?.job_id || Number(saved.affiliate_application_tab_id) !== senderTabId)) {
        return offlineScanResponse(message.scan);
      }
      if (!command?.job_id || Number(sender.tab?.id) !== Number(saved.affiliate_application_tab_id)) {
        throw new Error('Affiliate form job/tab identity mismatch.');
      }
      if (new URL(sender.tab.url).hostname.toLowerCase() !== command.application_host) {
        throw new Error('Form đã chuyển sang domain khác; cần tạo job/quyền mới.');
      }
      const frameId = Number(sender.frameId || 0);
      let frameOrigin = '';
      try { frameOrigin = `${new URL(String(sender.url || sender.tab.url)).origin}/*`; } catch { /* rejected below */ }
      const topOrigin = `${new URL(sender.tab.url).origin}/*`;
      if (frameId > 0 && frameOrigin !== topOrigin
          && !(saved.affiliate_popup_allowed_origins || []).includes(frameOrigin)) {
        return { message: 'Đang chờ khung chính xác nhận iframe popup.', ignored: true, retry_after_ms: 1200 };
      }
      const frameScore = affiliateFrameScore(message.scan, frameId);
      const selectedFrameId = Number(saved.affiliate_application_frame_id);
      const selectedFrameScore = Number(saved.affiliate_application_frame_score ?? -1);
      const selectedRecently = Date.now() - Number(saved.affiliate_application_frame_seen_at || 0) < 2000;
      const popupStillVisible = message.scan?.surface === 'popup';
      if (Number.isInteger(selectedFrameId) && selectedFrameId !== frameId && selectedFrameScore > frameScore
          && (selectedRecently || popupStillVisible)) {
        return { message: 'Đã bỏ qua vùng nền vì Helper đang theo form popup.', ignored: true,
          retry_after_ms: popupStillVisible ? 0 : 2200 };
      }
      let planned;
      try {
        planned = await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/scan`, {
          method: 'POST', body: { scan: message.scan, confirmed_sensitive_fields: [] },
        });
      } catch (error) {
        // Tool/Agent chết giữa chừng: đừng chết theo — điền tạm bằng hồ sơ offline đã học.
        const unreachable = /Không thấy Local Agent|Open Hi Auto|relay did not respond|Failed to fetch|NetworkError/i
          .test(String(error?.message ?? ''));
        if (!unreachable) throw error;
        notifyPanel({ kind: 'affiliate', level: 'warn',
          log: 'Mất kết nối tool giữa chừng — chuyển sang điền offline từ hồ sơ đã học.' });
        return offlineScanResponse(message.scan);
      }
      const displayPlan = await markAffiliateLocalSecrets(planned.plan, planned.job);
      const popupAllowed = frameId === 0 && displayPlan.surface === 'page'
        ? [] : [...new Set([...(saved.affiliate_popup_allowed_origins || []),
          ...(displayPlan.popup_frame_origins || [])])];
      await chrome.storage.session.set({ affiliate_application_command: planned.job,
        affiliate_application_frame_id: frameId, affiliate_application_frame_score: frameScore,
        affiliate_application_frame_seen_at: Date.now(),
        affiliate_popup_allowed_origins: popupAllowed,
        affiliate_fill_plan: displayPlan, affiliate_ai_suggestions: [] });
      await chrome.storage.session.remove(['affiliate_auto_fill_pending']);
      const runtimePlan = await affiliateRuntimePlan(displayPlan, planned.job);
      const autoFill = runtimePlan.fields.length > 0;
      const passwordTargets = affiliatePasswordTargets(displayPlan);
      const learnable = displayPlan.missing.length
        + (passwordTargets.length && !passwordTargets.some((item) => item.has_local_value) ? 1 : 0);
      const surface = displayPlan.surface === 'popup' || displayPlan.frame_context === 'embedded' ? ' trong popup' : '';
      notifyPanel({ log: `Đã nhận diện ${runtimePlan.fields.length} trường${surface} để điền; còn ${learnable} trường có thể học.`, kind: 'ok' });
      return { message: autoFill
        ? 'Đã tự quét và đang điền mọi trường đã học ở bước hiện tại.'
        : 'Đã tự quét form. Mở Side Panel để dạy các trường chưa biết.',
      plan: displayPlan, auto_fill_plan: autoFill ? runtimePlan : null };
    }
    if (message.type === 'APPLY_AFFILIATE_SAFE_FIELDS') {
      const saved = await savedState();
      if (!saved.affiliate_application_command?.job_id || !saved.affiliate_fill_plan) throw new Error('Chưa có form/plan để điền.');
      const runtimePlan = await affiliateRuntimePlan(saved.affiliate_fill_plan, saved.affiliate_application_command);
      const response = await sendAffiliateTabMessage(saved, {
        type: 'AFFILIATE_APPLY_PLAN', plan: runtimePlan,
      });
      if (!response?.ok) throw new Error(response?.error || 'Không thể điền form.');
      return { message: `Đã điền ${response.filled?.length ?? 0} trường đã học. Hãy kiểm tra trước khi chuyển bước.`, ...response };
    }
    if (message.type === 'CONFIRM_AFFILIATE_SENSITIVE_FIELDS') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      const ids = [...new Set((message.field_ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!command?.job_id || !ids.length) throw new Error('Chưa chọn trường nhạy cảm cần xác nhận.');
      const planned = await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/scan`, {
        method: 'POST', body: { scan: command.scan, confirmed_sensitive_fields: ids },
      });
      const displayPlan = await markAffiliateLocalSecrets(planned.plan, planned.job);
      await chrome.storage.session.set({ affiliate_application_command: planned.job, affiliate_fill_plan: displayPlan });
      return { message: `Đã xác nhận ${ids.length} trường nhạy cảm cho riêng bước này. Hãy bấm Điền để thực hiện.`, plan: displayPlan };
    }
    if (message.type === 'LEARN_AFFILIATE_MAPPING') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      if (!command?.job_id) throw new Error('Không có application job đang mở.');
      await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/learn`, {
        method: 'POST', body: { field_signature: message.field_signature, field_key: message.field_key,
          scope: message.scope || 'domain', form_signature: '' },
      });
      const planned = await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/scan`, {
        method: 'POST', body: { scan: command.scan, confirmed_sensitive_fields: [] },
      });
      const displayPlan = await markAffiliateLocalSecrets(planned.plan, planned.job);
      await chrome.storage.session.set({ affiliate_application_command: planned.job, affiliate_fill_plan: displayPlan });
      return { message: 'Đã học mapping cho domain này và lập lại kế hoạch điền.', plan: displayPlan };
    }
    if (message.type === 'LEARN_AFFILIATE_LOCAL_SECRET') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      if (!command?.job_id || !saved.affiliate_fill_plan) throw new Error('Không có form Affiliate đang mở.');
      const target = affiliatePasswordTargets(saved.affiliate_fill_plan)
        .find((item) => String(item.dom_id) === String(message.dom_id));
      if (!target || message.secret_kind !== 'password') throw new Error('Trường mật khẩu này không còn ở bước hiện tại. Hãy quét lại.');
      await saveAffiliateLocalPassword(command.profile_id, message.answer);
      const displayPlan = await markAffiliateLocalSecrets(saved.affiliate_fill_plan, command);
      await chrome.storage.session.set({ affiliate_fill_plan: displayPlan });
      const runtimePlan = await affiliateRuntimePlan(displayPlan, command);
      const passwordFields = runtimePlan.fields.filter((item) => item.locally_managed_secret);
      const applied = await sendAffiliateTabMessage(saved, {
        type: 'AFFILIATE_APPLY_PLAN',
        plan: { ...runtimePlan, fields: passwordFields, overwrite_manual: true, overwrite_existing: true },
        report: false,
      });
      if (!applied?.ok) throw new Error(applied?.error || 'Đã lưu nhưng chưa điền được mật khẩu vào form.');
      return { message: `Đã lưu mật khẩu cục bộ cho hồ sơ và điền ${applied.filled?.length ?? 0} ô Password/Confirm Password.`,
        filled: applied.filled?.length ?? 0 };
    }
    if (message.type === 'LEARN_AFFILIATE_ANSWER') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      if (!command?.job_id) throw new Error('Không có application job đang mở.');
      const answer = String(message.answer || '').trim();
      if (!answer) throw new Error('Hãy nhập câu trả lời trước khi lưu.');
      const result = await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/learn-answer`, {
        method: 'POST', body: {
          dom_id: message.dom_id, field_signature: message.field_signature,
          label: message.label, answer, field_key: message.field_key || null,
          scope: message.scope || 'global',
        },
      });
      const displayPlan = await markAffiliateLocalSecrets(result.plan, result.job);
      await chrome.storage.session.set({ affiliate_application_command: result.job,
        affiliate_fill_plan: displayPlan, affiliate_ai_suggestions: [] });
      const learnedField = (displayPlan?.fields ?? []).find((field) => field.dom_id === message.dom_id);
      let filled = 0;
      if (learnedField) {
        const applied = await sendAffiliateTabMessage(saved, {
          type: 'AFFILIATE_APPLY_PLAN',
          plan: { ...displayPlan, fields: [learnedField], overwrite_manual: true, overwrite_existing: true },
          report: false,
        });
        if (!applied?.ok) throw new Error(applied?.error || 'Đã lưu nhưng chưa điền được câu trả lời vào form.');
        filled = applied.filled?.length ?? 0;
      }
      return { message: filled
        ? 'Đã học câu trả lời, lưu vào hồ sơ và điền ngay trên form.'
        : (result.message || 'Đã lưu câu trả lời vào hồ sơ; trường trên trang hiện không còn khả dụng.'),
      plan: displayPlan, field: result.field, filled };
    }
    if (message.type === 'SUGGEST_AFFILIATE_AI_MAPPINGS') {
      const command = (await savedState()).affiliate_application_command;
      if (!command?.job_id) throw new Error('Không có application job đang mở.');
      const result = await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/ai-map`, {
        method: 'POST', body: {},
      });
      await chrome.storage.session.set({ affiliate_ai_suggestions: result.suggestions ?? [] });
      return { message: `AI đề xuất ${result.suggestions?.length ?? 0} mapping; chưa áp dụng mapping nào.`, ...result };
    }
    if (message.type === 'AFFILIATE_FORM_FILLED') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      const filledTabId = Number(sender.tab?.id);
      if (Number(saved.offline_fill_tab_id) === filledTabId
          && (!command?.job_id || Number(saved.affiliate_application_tab_id) !== filledTabId)) {
        // Điền offline không có job phía tool để báo tiến độ — ghi nhận tại chỗ là đủ.
        const filledCount = message.result?.filled?.length ?? 0;
        if (filledCount) notifyPanel({ kind: 'affiliate', level: 'ok', log: `Điền offline xong ${filledCount} trường.` });
        return { result: message.result, offline: true };
      }
      if (!command?.job_id || Number(sender.tab?.id) !== Number(saved.affiliate_application_tab_id)) throw new Error('Affiliate fill identity mismatch.');
      if (Number(sender.frameId || 0) !== Number(saved.affiliate_application_frame_id || 0)) {
        return { ignored: true, result: message.result };
      }
      const status = saved.affiliate_fill_plan?.submit_present ? 'submit_ready' : 'next';
      const updated = await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/progress`, {
        method: 'POST', body: { status, stage: 'safe_fields_filled' },
      });
      await chrome.storage.session.set({ affiliate_application_command: updated.job });
      return { result: message.result };
    }
    if (message.type === 'RESCAN_AFFILIATE_FORM') {
      return refreshAffiliateCurrentState();
    }
    if (message.type === 'MARK_AFFILIATE_SUBMITTED') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      if (!command?.job_id) throw new Error('Không có job đăng ký affiliate đang mở.');
      const updated = await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/progress`, {
        method: 'POST', body: { status: 'submitted', stage: 'human_confirmed_submission' },
      });
      await chrome.storage.session.remove(['affiliate_application_command', 'affiliate_fill_plan', 'affiliate_ai_suggestions',
        'affiliate_search_session', 'affiliate_search_root_tab_id', 'affiliate_search_tab_id',
        'affiliate_application_frame_id', 'affiliate_application_frame_score', 'affiliate_application_frame_seen_at',
        'affiliate_popup_allowed_origins', 'affiliate_popup_candidate_tab_id', 'affiliate_auto_fill_pending']);
      await notifyUi();
      const tabId = Number(saved.affiliate_application_tab_id);
      const rootTabId = Number(saved.affiliate_search_root_tab_id);
      await chrome.storage.session.remove(['affiliate_application_tab_id']);
      const closeIds = [...new Set([tabId, rootTabId].filter((id) => Number.isInteger(id)
        && id !== Number(saved.local_tab_id)))];
      if (closeIds.length) setTimeout(() => chrome.tabs.remove(closeIds).catch(() => {}), 250);
      return { message: 'Đã ghi nhận bạn tự nộp đơn. Helper không bấm submit.', job: updated.job };
    }
    if (message.type === 'CANCEL_AFFILIATE_APPLICATION') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      if (!command?.job_id) throw new Error('Không có application job đang mở.');
      await api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/progress`, {
        method: 'POST', body: { status: 'cancelled', stage: 'user_cancelled' },
      });
      await chrome.storage.session.remove(['affiliate_application_command', 'affiliate_fill_plan', 'affiliate_ai_suggestions',
        'affiliate_application_tab_id', 'affiliate_application_frame_id', 'affiliate_application_frame_score',
        'affiliate_application_frame_seen_at', 'affiliate_popup_candidate_tab_id',
        'affiliate_popup_allowed_origins', 'affiliate_search_session', 'affiliate_search_root_tab_id',
        'affiliate_search_tab_id',
        'affiliate_auto_fill_pending']);
      const tabId = Number(saved.affiliate_application_tab_id);
      const rootTabId = Number(saved.affiliate_search_root_tab_id);
      const closeIds = [...new Set([tabId, rootTabId].filter((id) => Number.isInteger(id)
        && id !== Number(saved.local_tab_id)))];
      if (closeIds.length) await chrome.tabs.remove(closeIds).catch(() => {});
      return { message: 'Đã huỷ trợ giúp đăng ký và đóng tab do Helper mở.' };
    }
    if (message.type === 'AFFILIATE_FORM_ERROR') {
      const saved = await savedState(); const command = saved.affiliate_application_command;
      if (!command?.job_id) return { message: 'Không có application job đang mở.' };
      if (Number(sender.tab?.id) !== Number(saved.affiliate_application_tab_id)
          || Number(sender.frameId || 0) !== Number(saved.affiliate_application_frame_id || 0)) {
        return { ignored: true, message: 'Đã bỏ qua lỗi từ vùng nền không được chọn.' };
      }
      return api(`/api/ads-miner/affiliate-helper/helper/jobs/${command.job_id}/progress`, {
        method: 'POST', body: { status: 'needs_user', stage: 'scan_failed', error_code: 'PAGE_CHANGED',
          error_message: message.error_message },
      });
    }
    if (message.type === 'COUPON_SERP_RESULT') {
      return { accepted: coupon.acceptSerpResult(message.payload ?? {}) };
    }
    if (message.type === 'COUPON_QUEUE_RUN') {
      const depth = ['quick', 'normal', 'deep'].includes(message.search_depth)
        ? message.search_depth : 'normal';
      const targetCount = Math.max(1, Math.min(Number(message.target_count)
        || 10, 10));
      const rawCountry = String(message.country || 'US');
      const rawLanguage = String(message.language || 'en');
      if (!/^[A-Za-z]{2}$/.test(rawCountry)) throw new Error('Quốc gia phải là mã ISO gồm 2 chữ cái.');
      if (!/^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/.test(rawLanguage)) throw new Error('Ngôn ngữ phải có dạng en hoặc en-US.');
      const country = rawCountry.toUpperCase();
      const language = rawLanguage.toLowerCase();
      if (message.all === true) {
        const only = ['all', 'affiliate_fit', 'has_kp', 'has_ads', 'high_volume', 'no_data'].includes(message.only)
          ? message.only : 'affiliate_fit';
        const sort = ['kp_volume', 'ad_creatives', 'advertisers', 'third_party', 'name', 'newest'].includes(message.sort)
          ? message.sort : 'third_party';
        const created = await api('/api/ads-miner/coupon-discovery/jobs/all', {
          method: 'POST', body: { search_depth: depth, target_count: targetCount, country, language, only, sort },
        });
        if (!created.eligible_count) return { message: 'Không còn dự án phù hợp bộ lọc để tìm coupon.' };
        await coupon.setPreferredJobs([]);
        await coupon.setPaused(false);
        coupon.driveQueue({ maxJobs: Math.max(1, created.eligible_count) }).then(() => notifyPanel({}))
          .catch((error) => notifyPanel({ log: `Hàng đợi đã dừng an toàn: ${error.message}`, kind: 'error' }));
        return { message: `Đã xếp ${created.created_count}/${created.eligible_count} dự án phù hợp vào hàng đợi.` };
      }
      const requested = Math.max(1, Math.min(Number(message.count) || 1, 25));
      let ids = Array.isArray(message.screening_ids)
        ? [...new Set(message.screening_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 25)
        : [];
      if (!ids.length) {
        const projects = await api(`/api/ads-miner/coupon-discovery/projects?limit=${requested}&only=affiliate_fit&sort=third_party`);
        ids = (projects.items ?? []).map((item) => item.screening_id);
      }
      if (!ids.length) return { message: 'Không còn dự án nào thiếu coupon.' };
      // Cú bấm trực tiếp là một lượt quét mới. Dừng executor cũ trước khi backend tạo
      // job thay thế để nó không thể claim/ghi tiếp vào snapshot vừa bị thay.
      try { await coupon.cancelCurrent(); } catch { /* Backend replace_existing vẫn là trọng tài cuối. */ }
      await coupon.discardLocalRun();
      const created = await api('/api/ads-miner/coupon-discovery/jobs', {
        method: 'POST',
        body: { screening_ids: ids, search_depth: depth, target_count: targetCount, country, language },
      });
      // Cú bấm trực tiếp phải chạy đúng các dự án vừa chọn theo đúng thứ tự, không để job cũ
      // còn sót trong hàng đợi chen lên trước. Danh sách nằm trong storage.session nên SW reload vẫn giữ.
      await coupon.setPreferredJobs((created.created ?? []).map((job) => job.job_id));
      await coupon.setPaused(false);
      coupon.driveQueue({ maxJobs: requested }).then(() => notifyPanel({}))
        .catch((error) => notifyPanel({ log: `Hàng đợi đã dừng an toàn: ${error.message}`, kind: 'error' }));
      if (!created.created_count && created.skipped?.length) {
        const existing = created.skipped[0];
        const held = ['needs_user', 'needs_login'].includes(existing.status);
        return { message: held
          ? 'Dự án đã có job đang chờ thao tác thủ công — xem hướng dẫn màu cam trong Side Panel.'
          : 'Dự án đã có job trong hàng đợi — Helper đang tiếp tục từ checkpoint gần nhất.' };
      }
      return { message: `Đã xếp ${created.created_count} dự án vào hàng đợi.` };
    }
    if (message.type === 'COUPON_QUEUE_PAUSE') {
      await coupon.setPaused(Boolean(message.paused));
      await api('/api/ads-miner/coupon-discovery/queue/pause', { method: 'POST', body: { paused: Boolean(message.paused) } });
      if (!message.paused) coupon.driveQueue().then(() => notifyPanel({}))
        .catch((error) => notifyPanel({ log: `Hàng đợi đã dừng an toàn: ${error.message}`, kind: 'error' }));
      return { message: message.paused ? 'Đã tạm dừng hàng đợi.' : 'Đã cho hàng đợi chạy tiếp.' };
    }
    if (message.type === 'COUPON_JOB_PAUSE') { await coupon.setPaused(true); return { message: 'Sẽ dừng sau bước hiện tại.' }; }
    if (message.type === 'COUPON_JOB_CANCEL') {
      const state = await coupon.currentState();
      const currentJobId = state.job?.job_id ?? state.coupon_job?.job_id;
      if (message.job_id && currentJobId && message.job_id !== currentJobId) {
        return { message: 'Job được chọn không phải job đang chạy trong Helper.' };
      }
      return coupon.cancelCurrent();
    }
    if (message.type === 'COUPON_JOB_SKIP') {
      const skipped = await coupon.cancelCurrent({ keepWorkTab: true, skipped: true });
      coupon.driveQueue().then(() => notifyPanel({}))
        .catch((error) => notifyPanel({ log: `Không thể chuyển sang dự án kế tiếp: ${error.message}`, kind: 'error' }));
      return skipped;
    }
    if (message.type === 'COUPON_SOURCE_SKIP') {
      const skipped = await coupon.skipCurrentSource();
      coupon.driveQueue().then(() => notifyPanel({}))
        .catch((error) => notifyPanel({ log: `Không thể chuyển sang nguồn khác: ${error.message}`, kind: 'error' }));
      return { message: `Đã bỏ ${skipped.source_domain}; đang quay lại tìm trong ${skipped.remaining_sources} nguồn còn lại hoặc truy vấn Google kế tiếp.` };
    }
    if (message.type === 'COUPON_JOB_RESUME') {
      const state = await coupon.currentState();
      if (!state.job && ['needs_user', 'needs_login', 'paused'].includes(state.recentJob?.status)) {
        await coupon.restoreHeld(state.recentJob);
      }
      const prepared = await coupon.prepareResume();
      await coupon.setPaused(false);
      notifyPanel({ log: prepared.hostname
        ? `Đang mở và quét ${prepared.hostname}…` : 'Đang đưa tab làm việc lên và chạy tiếp…', kind: 'ok' });
      coupon.driveQueue().then(() => notifyPanel({}))
        .catch((error) => notifyPanel({ log: `Không thể chạy tiếp: ${error.message}`, kind: 'error' }));
      return { message: prepared.hostname ? `Đang quét ${prepared.hostname}.` : 'Đang chạy tiếp.' };
    }
    if (message.type === 'COUPON_JOB_DEEPER') {
      const state = await coupon.currentState();
      const requestedScreeningId = Number(message.screening_id);
      const screeningId = Number.isInteger(requestedScreeningId) && requestedScreeningId > 0
        ? requestedScreeningId
        : state.job?.screening_id;
      const targetCount = Math.max(1, Math.min(Number(message.target_count) || state.job?.target_count || 10, 10));
      const country = message.country || state.job?.country || 'US';
      const language = message.language || state.job?.language || 'en';
      if (!Number.isInteger(screeningId) || screeningId <= 0) return { message: 'Chưa có dự án nào để tìm sâu hơn.' };
      const created = await api('/api/ads-miner/coupon-discovery/jobs', {
        method: 'POST',
        body: { screening_ids: [screeningId], search_depth: 'deep', target_count: targetCount, country, language },
      });
      if (!created.created_count) return { message: 'Dự án này đang có job mở; hãy chờ hoặc hủy job hiện tại.' };
      coupon.driveQueue({ maxJobs: 1 }).then(() => notifyPanel({}))
        .catch((error) => notifyPanel({ log: `Lượt tìm sâu đã dừng an toàn: ${error.message}`, kind: 'error' }));
      return { message: 'Đã xếp thêm một lượt tìm sâu cho dự án này.' };
    }
    if (message.type === 'COUPON_SYNC_CANDIDATES') {
      const ids = Array.isArray(message.candidate_ids) ? message.candidate_ids : [];
      if (!ids.length) return { message: 'Chưa chọn mã nào.' };
      let promoted = 0;
      const synced = [];
      for (const id of ids) {
        try {
          const result = await api(`/api/ads-miner/coupon-discovery/candidates/${Number(id)}/review`, { method: 'POST', body: { decision: 'accept' } });
          if (result.promoted && result.project?.coupon_status !== 'not_found_yet') {
            promoted += 1;
            synced.push(`${result.candidate?.code || `#${id}`} → ${result.project?.brand_name || result.project?.provider_domain || 'dự án'}`);
          } else {
            notifyPanel({ log: `Mã #${id}: Hi Auto chưa xác nhận đã lưu vào dự án.`, kind: 'error' });
          }
        } catch (error) { notifyPanel({ log: `Mã #${id}: ${error.message}`, kind: 'error' }); }
      }
      return { message: promoted === ids.length
        ? `Đã lưu ${promoted}/${ids.length} mã vào dự án Hi Auto: ${synced.join(', ')}. Dự án đã rời danh sách thiếu coupon.`
        : `Chỉ lưu được ${promoted}/${ids.length} mã. Xem lỗi phía trên; mã chưa xác nhận vẫn được giữ lại.` };
    }
    if (message.type === 'SAVE_VALENTIN_STATE') return api('/api/ads-miner/discovery/helper/valentin', { method: 'POST', body: message.payload });
    if (message.type === 'SAVE_ADVERTISER_PROFILE') return api('/api/ads-miner/discovery/helper/advertiser-profile', { method: 'POST', body: message.payload });
    if (message.type === 'SAVE_CREATIVE_COLLECTION') return api('/api/ads-miner/discovery/helper/creative-collection', { method: 'POST', body: message.payload });
    throw new Error(`Unknown Browser Helper message: ${message.type}`);
  })().then((value) => sendResponse({ ok: true, ...value })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
