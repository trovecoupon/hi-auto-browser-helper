import { withAnywhereRegion } from './job-orchestrator.mjs';

function fingerprint(value) {
  const input = String(value ?? ''); let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) { hash ^= input.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `fp_${hash.toString(16).padStart(8, '0')}`;
}

export function frameContentFingerprint(snapshot = {}) {
  return fingerprint([snapshot.headline, snapshot.description, snapshot.display_url, snapshot.display_path,
    snapshot.landing_url, snapshot.creative_text, snapshot.image_count, ...(snapshot.image_urls ?? [])]
    .map((value) => String(value ?? '').trim()).join('|'));
}

export function hasFrameContent(snapshot = {}) { return Boolean(snapshot.headline || snapshot.description || snapshot.display_url
  || snapshot.display_path || snapshot.landing_url || snapshot.creative_text || snapshot.image_count
  || snapshot.image_urls?.length); }

function safeImageUrls(values) {
  const seen = new Set(); const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    try {
      const url = new URL(String(value));
      if (url.protocol !== 'https:' || url.toString().length > 4096 || seen.has(url.toString())) continue;
      seen.add(url.toString()); out.push(url.toString());
      if (out.length >= 8) break;
    } catch {}
  }
  return out;
}

export function advertiserIdFromProfileUrl(value) { return String(value ?? '').match(/\/advertiser\/(AR\d+)/i)?.[1] ?? null; }

export function createDocumentIdentity({ crypto_object = globalThis.crypto, now_ms = () => Date.now(), random = () => Math.random() } = {}) {
  if (typeof crypto_object?.randomUUID === 'function') return `doc_${crypto_object.randomUUID()}`;
  if (typeof crypto_object?.getRandomValues === 'function') { const values = new Uint32Array(4); crypto_object.getRandomValues(values); return `doc_${[...values].map((value) => value.toString(16).padStart(8, '0')).join('')}`; }
  return `doc_${now_ms().toString(36)}_${random().toString(36).slice(2)}_${random().toString(36).slice(2)}`;
}

export function validateFrameSnapshotMessage(message, sender = {}) {
  const parentUrl = String(sender.tab?.url ?? ''); const frameUrl = String(sender.url ?? message?.snapshot?.frame_url ?? '');
  if (message?.type !== 'ADS_FRAME_SNAPSHOT') return { accepted: false, reason: 'wrong_message_type' };
  if (!/^https:\/\/adstransparency\.google\.com\//i.test(parentUrl)) return { accepted: false, reason: 'parent_tab_not_ads_transparency' };
  if (!Number.isInteger(sender.frameId) || sender.frameId <= 0) return { accepted: false, reason: 'top_frame_rejected' };
  if (!/^https:\/\/www\.google\.com\//i.test(frameUrl)) return { accepted: false, reason: 'frame_origin_not_google' };
  const snapshot = message.snapshot ?? {}; const sequence = Number(snapshot.sequence ?? 0);
  if (!Number.isInteger(sequence) || sequence < 1) return { accepted: false, reason: 'invalid_sequence' };
  const contentDocumentIdentity = String(snapshot.document_identity ?? '');
  if (!/^doc_[a-z0-9_-]{8,200}$/i.test(contentDocumentIdentity)) return { accepted: false, reason: 'missing_document_identity' };
  const documentIdentity = contentDocumentIdentity;
  const contentFingerprint = snapshot.content_fingerprint ?? frameContentFingerprint(snapshot);
  return { accepted: true, snapshot: {
    frame_id: sender.frameId, document_id: sender.documentId ?? null, document_identity: documentIdentity, frame_url: frameUrl, parent_url: parentUrl,
    advertiser_id: advertiserIdFromProfileUrl(parentUrl), sequence, observed_at: snapshot.observed_at ?? new Date().toISOString(),
    content_fingerprint: contentFingerprint, ready_state: snapshot.ready_state ?? null,
    creative_text: snapshot.creative_text || null, headline: snapshot.headline || null, description: snapshot.description || null,
    display_url: snapshot.display_url || null, display_path: snapshot.display_path || null,
    landing_url: snapshot.landing_url || null, image_count: Math.max(0, Number(snapshot.image_count) || 0),
    image_urls: safeImageUrls(snapshot.image_urls),
    evidence: snapshot.evidence || null
  } };
}

function canonicalProfileUrl(value) {
  try { const url = new URL(withAnywhereRegion(value)); return `${url.origin}${url.pathname}${url.search}`; } catch { return String(value ?? ''); }
}

export class FrameSnapshotCache {
  constructor() { this.tabs = new Map(); this.auth = null; }
  setAuth(auth) { this.auth = { session_id: auth.session_id, token: auth.token }; this.clearAll(); }
  clearAll() { this.tabs.clear(); }
  clearTab(tabId) { this.tabs.delete(Number(tabId)); }
  removeTab(tabId) { this.clearTab(tabId); }
  accept(tabId, snapshot) {
    const numericTab = Number(tabId); const tab = this.tabs.get(numericTab) ?? new Map(); const key = String(snapshot.frame_id);
    const existing = tab.get(key); const identity = snapshot.document_identity ?? (snapshot.document_id ? `chrome_${snapshot.document_id}` : null); const existingIdentity = existing?.document_identity ?? (existing?.document_id ? `chrome_${existing.document_id}` : null);
    const sameDocument = existing && existingIdentity === identity && existing.frame_url === snapshot.frame_url;
    if (sameDocument && snapshot.sequence <= existing.sequence) return { stored: false, reason: 'stale_sequence' };
    if (sameDocument && snapshot.content_fingerprint === existing.content_fingerprint) return { stored: false, reason: 'same_fingerprint' };
    if (sameDocument && hasFrameContent(existing) && !hasFrameContent(snapshot)) return { stored: false, reason: 'empty_does_not_replace_content' };
    tab.set(key, snapshot); this.tabs.set(numericTab, tab); return { stored: true, snapshot };
  }
  get(tabId, currentProfileUrl) {
    const expectedUrl = canonicalProfileUrl(currentProfileUrl); const expectedAdvertiser = advertiserIdFromProfileUrl(currentProfileUrl);
    return [...(this.tabs.get(Number(tabId))?.values() ?? [])].filter((snapshot) => canonicalProfileUrl(snapshot.parent_url) === expectedUrl && snapshot.advertiser_id === expectedAdvertiser);
  }
}

export async function observeFrameSnapshots({ read_snapshot, send_snapshot, wait_for_signal, timeout_ms = 7000, poll_ms = 250, stable_rounds = 5, max_messages = 5, now_ms = () => Date.now() }) {
  const wait = wait_for_signal ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); const started = now_ms();
  let sequence = 0, messages = 0, stable = 0, lastObservedFingerprint = null, lastSentFingerprint = null, stop_reason = 'timeout';
  while (now_ms() - started < timeout_ms && messages < max_messages) {
    const snapshot = await read_snapshot(); const contentFingerprint = frameContentFingerprint(snapshot);
    stable = contentFingerprint === lastObservedFingerprint ? stable + 1 : 0; lastObservedFingerprint = contentFingerprint;
    if (contentFingerprint !== lastSentFingerprint) {
      sequence++; messages++; lastSentFingerprint = contentFingerprint;
      await send_snapshot({ ...snapshot, sequence, observed_at: snapshot.observed_at ?? new Date().toISOString(), content_fingerprint: contentFingerprint });
    }
    if (hasFrameContent(snapshot) && stable >= stable_rounds) { stop_reason = 'stable_content'; break; }
    if (messages >= max_messages) { stop_reason = 'maximum_messages'; break; }
    await wait(poll_ms);
  }
  return { messages, last_fingerprint: lastSentFingerprint, stop_reason };
}
