import {
  DEFAULT_HARVESTER_SETTINGS, HARVESTER_STORAGE_KEYS, candidateToCoupon,
  harvesterCouponToBlock, mergeHarvesterCoupons, normalizeRule, scoreHarvesterCandidate,
} from './coupon-harvester.mjs';

const [COUPONS_KEY, SETTINGS_KEY, RULES_KEY, ACTIVE_KEY, REVIEW_KEY] = HARVESTER_STORAGE_KEYS;

function sessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createHarvesterRuntime({ storageLocal, storageSession, scripting, tabs, sidePanel, action, notify = () => {} }) {
  async function settings() {
    const saved = await storageLocal.get([SETTINGS_KEY]);
    return { ...DEFAULT_HARVESTER_SETTINGS, ...(saved[SETTINGS_KEY] ?? {}) };
  }

  async function activeSessions() {
    return (await storageSession.get([ACTIVE_KEY]))[ACTIVE_KEY] ?? {};
  }

  async function persistSessions(value) { await storageSession.set({ [ACTIVE_KEY]: value }); }

  async function start(tabId, meta = {}) {
    const tab = await tabs.get(Number(tabId));
    if (!/^https?:\/\//i.test(tab.url ?? '')) throw new Error('Coupon Harvester chỉ chạy trên trang web HTTP/HTTPS.');
    const origin = new URL(tab.url).origin;
    const allRules = (await storageLocal.get([RULES_KEY]))[RULES_KEY] ?? [];
    const currentSettings = await settings();
    const sessions = await activeSessions();
    const prior = sessions[tabId];
    const sameCapture = prior?.jobId === (meta.jobId ?? prior?.jobId ?? null)
      && (prior?.origin === origin || Number.isInteger(prior?.parentTabId));
    const id = sameCapture ? prior.namespace : sessionId();
    const session = {
      namespace: id, tabId: Number(tabId), origin, url: tab.url, jobId: meta.jobId ?? prior?.jobId ?? null,
      parentTabId: meta.parentTabId ?? prior?.parentTabId ?? null, startedAt: prior?.startedAt ?? Date.now(),
      updatedAt: Date.now(), enabled: true,
    };
    sessions[tabId] = session;
    await persistSessions(sessions);
    const rules = allRules.filter((rule) => rule.hostname === new URL(tab.url).hostname.toLowerCase());
    const targets = { tabId: Number(tabId), allFrames: true };
    await scripting.executeScript({
      target: targets, world: 'MAIN', injectImmediately: true,
      func: (namespace, settings) => {
        globalThis.__HI_AUTO_HARVESTER_NS__ = namespace;
        globalThis.__HI_AUTO_HARVESTER_MAIN_CONFIG__ = settings;
      }, args: [id, currentSettings],
    });
    await scripting.executeScript({ target: targets, world: 'MAIN', injectImmediately: true, files: ['content/harvester-main.js'] });
    await scripting.executeScript({
      target: targets, world: 'ISOLATED', injectImmediately: true,
      func: (config) => { globalThis.__HI_AUTO_HARVESTER_CONFIG__ = config; },
      args: [{ namespace: id, settings: currentSettings, rules }],
    });
    await scripting.executeScript({ target: targets, world: 'ISOLATED', injectImmediately: true, files: ['content/harvester-isolated.js'] });
    return session;
  }

  async function stop(tabId) {
    const sessions = await activeSessions();
    delete sessions[tabId];
    await persistSessions(sessions);
    return true;
  }

  async function receive(message, sender) {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) return { accepted: 0, reason: 'no_tab' };
    const sessions = await activeSessions();
    const session = sessions[tabId];
    if (!session || session.namespace !== message.namespace) return { accepted: 0, reason: 'session_mismatch' };
    const stored = await storageLocal.get([COUPONS_KEY, REVIEW_KEY]);
    const currentSettings = await settings();
    const accepted = [];
    const review = [];
    for (const raw of (message.candidates ?? []).slice(0, 100)) {
      const candidate = {
        ...raw, sourceUrl: String(raw.sourceUrl ?? sender.url ?? session.url),
        hostname: String(raw.hostname ?? new URL(sender.url ?? session.url).hostname).toLowerCase(),
        detectedBy: [...new Set(raw.detectedBy ?? [])], firstSeen: Number(raw.firstSeen) || Date.now(),
        lastSeen: Number(raw.lastSeen) || Date.now(),
      };
      const domainOverride = currentSettings.domainOverrides?.[candidate.hostname] ?? {};
      const score = scoreHarvesterCandidate(candidate, {
        allowCodes: [...(currentSettings.allowCodes ?? []), ...(domainOverride.allowCodes ?? [])],
        blockCodes: [...(currentSettings.blockCodes ?? []), ...(domainOverride.blockCodes ?? [])],
      });
      if (score.decision === 'reject') continue;
      const coupon = { ...candidateToCoupon(candidate, score), _sessionId: session.namespace, _tabId: tabId, _jobId: session.jobId, _decision: score.decision, _frameId: sender.frameId ?? 0 };
      if (score.decision === 'auto_save') accepted.push(coupon); else review.push(coupon);
    }
    if (!accepted.length && !review.length) return { accepted: 0, review: 0 };
    const coupons = mergeHarvesterCoupons(stored[COUPONS_KEY] ?? [], [...accepted, ...review]);
    const reviews = mergeHarvesterCoupons(stored[REVIEW_KEY] ?? [], review).filter((coupon) => !coupon.verified);
    await storageLocal.set({ [COUPONS_KEY]: coupons, [REVIEW_KEY]: reviews });
    const freshCount = accepted.length + review.length;
    await action?.setBadgeBackgroundColor?.({ color: '#6d5ef6' });
    await action?.setBadgeText?.({ text: String(Math.min(99, freshCount)) });
    tabs.sendMessage(tabId, { type: 'HARVESTER_NOTIFY', count: freshCount, review: review.length > 0 }).catch(() => {});
    notify({ log: `Coupon Harvester bắt được ${freshCount} mã trên ${candidateHost([...accepted, ...review])}.`, kind: 'ok' });
    return { accepted: accepted.length, review: review.length, jobId: session.jobId };
  }

  async function snapshot(tabId, jobId = null) {
    const sessions = await activeSessions();
    const session = sessions[tabId];
    if (!session) return { blocks: [], coupons: [], session: null };
    try { await tabs.sendMessage(Number(tabId), { type: 'HARVESTER_SCAN_NOW', method: 'text' }); } catch { /* frame may still be loading */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const coupons = (await storageLocal.get([COUPONS_KEY]))[COUPONS_KEY] ?? [];
    const relevant = coupons.filter((coupon) => coupon._sessionId === session.namespace && (!jobId || coupon._jobId === jobId));
    return { blocks: relevant.map(harvesterCouponToBlock), coupons: relevant, session };
  }

  async function state({ hostname = null, jobId = null } = {}) {
    const saved = await storageLocal.get([COUPONS_KEY, REVIEW_KEY, RULES_KEY, SETTINGS_KEY]);
    const filterRelevant = (items) => (items ?? []).filter((item) =>
      (!hostname || item.hostname === hostname) && (!jobId || item._jobId === jobId));
    return {
      coupons: filterRelevant(saved[COUPONS_KEY]).slice(0, 100), review: filterRelevant(saved[REVIEW_KEY]).slice(0, 100),
      rules: hostname ? (saved[RULES_KEY] ?? []).filter((item) => item.hostname === hostname) : [],
      settings: { ...DEFAULT_HARVESTER_SETTINGS, ...(saved[SETTINGS_KEY] ?? {}) },
      active: Object.values(await activeSessions()),
    };
  }

  async function updateSettings(patch) {
    const current = await settings();
    const safe = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => key in DEFAULT_HARVESTER_SETTINGS));
    for (const key of ['allowCodes', 'blockCodes']) safe[key] = [...new Set((safe[key] ?? current[key] ?? []).map((value) => String(value).trim().toUpperCase()).filter(Boolean))].slice(0, 1000);
    if (safe.domainOverrides) {
      if (typeof safe.domainOverrides !== 'object' || Array.isArray(safe.domainOverrides)) throw new Error('domainOverrides phải là object theo hostname.');
      safe.domainOverrides = Object.fromEntries(Object.entries(safe.domainOverrides).slice(0, 500).flatMap(([hostname, value]) => {
        if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(hostname) || !value || typeof value !== 'object' || Array.isArray(value)) return [];
        const clean = (items) => [...new Set((Array.isArray(items) ? items : []).map((item) => String(item).trim().toUpperCase()).filter(Boolean))].slice(0, 1000);
        return [[hostname.toLowerCase(), { allowCodes: clean(value.allowCodes), blockCodes: clean(value.blockCodes) }]];
      }));
    }
    const next = { ...current, ...safe };
    await storageLocal.set({ [SETTINGS_KEY]: next }); return next;
  }

  async function saveRule(rawRule) {
    const rule = normalizeRule(rawRule);
    const saved = await storageLocal.get([RULES_KEY]);
    const rules = (saved[RULES_KEY] ?? []).filter((item) => item.id !== rule.id);
    rules.push(rule); await storageLocal.set({ [RULES_KEY]: rules }); return rule;
  }

  async function staleRule(ruleId, reason) {
    const saved = await storageLocal.get([RULES_KEY]);
    const rules = (saved[RULES_KEY] ?? []).map((rule) => rule.id === ruleId ? { ...rule, stale: true, staleReason: String(reason).slice(0, 120), updatedAt: Date.now() } : rule);
    await storageLocal.set({ [RULES_KEY]: rules });
  }

  async function deleteRule(ruleId) {
    const saved = await storageLocal.get([RULES_KEY]);
    await storageLocal.set({ [RULES_KEY]: (saved[RULES_KEY] ?? []).filter((rule) => rule.id !== ruleId) });
  }

  async function verifyCoupon(id, verified) {
    const saved = await storageLocal.get([COUPONS_KEY, REVIEW_KEY]);
    const coupons = (saved[COUPONS_KEY] ?? []).map((coupon) => coupon.id === id ? { ...coupon, verified: Boolean(verified), _decision: verified ? 'auto_save' : coupon._decision } : coupon);
    const review = (saved[REVIEW_KEY] ?? []).filter((coupon) => coupon.id !== id || !verified);
    await storageLocal.set({ [COUPONS_KEY]: coupons, [REVIEW_KEY]: review });
  }

  async function clear() {
    await storageLocal.remove([COUPONS_KEY, REVIEW_KEY]);
    await action?.setBadgeText?.({ text: '' });
  }

  async function exportData(format = 'json') {
    const coupons = (await state()).coupons.map(({ _sessionId, _tabId, _jobId, _decision, _frameId, ...coupon }) => coupon);
    if (format === 'csv') {
      const columns = ['code', 'hostname', 'sourceUrl', 'offerTitle', 'description', 'conditions', 'expiresAt', 'confidence', 'detectedBy', 'firstSeen', 'lastSeen', 'verified'];
      const csv = [columns, ...coupons.map((coupon) => columns.map((key) => key === 'detectedBy' ? coupon[key].join('|') : coupon[key] ?? ''))]
        .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      return { mime: 'text/csv', filename: `hi-auto-coupons-${Date.now()}.csv`, text: csv };
    }
    return { mime: 'application/json', filename: `hi-auto-coupons-${Date.now()}.json`, text: JSON.stringify(coupons, null, 2) };
  }

  async function attachChild(tab) {
    if (!Number.isInteger(tab?.openerTabId) || !Number.isInteger(tab.id)) return null;
    const sessions = await activeSessions();
    const parent = sessions[tab.openerTabId];
    if (!parent) return null;
    sessions[tab.id] = { ...parent, tabId: tab.id, parentTabId: tab.openerTabId, url: tab.pendingUrl ?? tab.url ?? '', updatedAt: Date.now() };
    await persistSessions(sessions); return sessions[tab.id];
  }

  async function reinjectIfActive(tabId) {
    const session = (await activeSessions())[tabId];
    if (!session) return false;
    try { await start(tabId, { jobId: session.jobId, parentTabId: session.parentTabId }); return true; } catch { return false; }
  }

  async function captureUrl(tabId, sourceUrl) {
    const session = (await activeSessions())[tabId];
    if (!session || !sourceUrl) return { accepted: 0 };
    let url;
    try { url = new URL(sourceUrl); } catch { return { accepted: 0 }; }
    const pairs = [...url.searchParams];
    const hash = url.hash.slice(1);
    if (hash) pairs.push(...new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash));
    const candidates = pairs.filter(([key, value]) => /coupon|promo|voucher|discount|offer|code/i.test(key) && value).map(([key, value]) => ({
      rawCode: value, hostname: url.hostname, sourceUrl: url.href, context: `${key}=${value}`,
      detectedBy: ['url'], explicitLabel: true, nearKeyword: true, firstSeen: Date.now(), lastSeen: Date.now(),
    }));
    return receive({ namespace: session.namespace, candidates }, { tab: { id: Number(tabId), url: url.href }, url: url.href, frameId: 0 });
  }

  async function openPanel(tabId) {
    if (sidePanel?.open && Number.isInteger(tabId)) await sidePanel.open({ tabId });
  }

  return { start, stop, receive, snapshot, state, updateSettings, saveRule, staleRule, deleteRule, verifyCoupon, clear, exportData, attachChild, reinjectIfActive, captureUrl, openPanel };
}

function candidateHost(coupons) { return coupons[0]?.hostname ?? 'trang hiện tại'; }
