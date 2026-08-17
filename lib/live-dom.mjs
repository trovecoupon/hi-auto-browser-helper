const CREATIVE_SELECTOR = 'a[href*="/creative/CR"]';

export function cleanInline(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
export function cleanMultiline(value) {
  return String(value ?? '').replace(/\r/g, '').split('\n').map((line) => cleanInline(line)).filter(Boolean).join('\n');
}

function fingerprint(value) {
  const input = String(value ?? ''); let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) { hash ^= input.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `fp_${hash.toString(16).padStart(8, '0')}`;
}

function absolute(value, base) { try { return new URL(value, base).toString(); } catch { return null; } }
function creativeId(value) { return String(value ?? '').match(/\/creative\/(CR\d+)/i)?.[1] ?? null; }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function visible(node) {
  if (!node || node.isConnected === false) return false;
  if (node.hidden || node.getAttribute?.('hidden') != null || node.getAttribute?.('aria-hidden') === 'true') return false;
  const style = globalThis.getComputedStyle?.(node);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden');
}
function query(node, selector) { return node?.querySelectorAll ? [...node.querySelectorAll(selector)] : []; }
function first(node, selector) { return node?.querySelector?.(selector) ?? query(node, selector)[0] ?? null; }
function hrefOf(anchor) { return anchor?.getAttribute?.('href') ?? anchor?.href ?? ''; }
function nodePath(node, scopePath = 'document') {
  const parts = []; let current = node;
  while (current && parts.length < 8) { parts.unshift(String(current.localName ?? 'node')); current = current.parentElement ?? null; }
  return `${scopePath}>${parts.join('>')}`;
}

export function walkOpenDom(root, { max_nodes = 5000, max_depth = 12 } = {}) {
  const records = []; const warnings = []; const roots = [{ root, depth: 0, scope_path: 'document' }];
  const queue = []; let visited = 0; let depthLimited = false;
  const children = (node) => node?.children ? [...node.children] : query(node, '*');
  const fairOrder = (nodes) => {
    const ordered = []; let left = 0; let right = nodes.length - 1;
    while (left <= right) { ordered.push(nodes[left++]); if (left <= right) ordered.push(nodes[right--]); }
    return ordered;
  };
  const enqueueChildren = (container, depth, path, priority = false) => {
    const tasks = fairOrder(children(container)).map((node) => ({ node, depth, scope_path: path, priority }));
    if (priority) queue.unshift(...tasks); else queue.push(...tasks);
  };
  enqueueChildren(root, 0, 'document');
  while (queue.length && visited < max_nodes) {
    const current = queue.shift(); visited++;
    records.push(current);
    if (current.node.shadowRoot) {
      if (current.depth >= max_depth) depthLimited = true;
      else {
        const scopePath = `${current.scope_path}>${current.node.localName ?? 'component'}#shadow`;
        roots.push({ root: current.node.shadowRoot, depth: current.depth + 1, scope_path: scopePath });
        // Open shadow content gets priority as soon as its host is discovered, so a
        // large light DOM cannot consume the remaining bounded traversal budget.
        enqueueChildren(current.node.shadowRoot, current.depth + 1, scopePath, true);
      }
    }
    enqueueChildren(current.node, current.depth, current.scope_path, current.priority || current.depth > 0);
  }
  if (depthLimited) warnings.push('shadow_depth_limit_reached');
  if (queue.length) warnings.push('shadow_node_limit_reached');
  return { records, roots, warnings, visited_nodes: visited };
}

function nodeCreativeIds(node) {
  const anchors = node?.matches?.(CREATIVE_SELECTOR) ? [node, ...query(node, CREATIVE_SELECTOR)] : query(node, CREATIVE_SELECTOR);
  return unique(anchors.map((anchor) => creativeId(hrefOf(anchor))));
}

function advertiserId(value) { return String(value ?? '').match(/\/advertiser\/(AR\d+)/i)?.[1] ?? null; }
function exactAdvertiserProfile(value, sourceUrl) {
  try {
    const candidate = new URL(value, sourceUrl); const expected = advertiserId(sourceUrl);
    return candidate.hostname === 'adstransparency.google.com'
      && candidate.pathname.replace(/\/+$/, '') === `/advertiser/${expected}`;
  } catch { return false; }
}
function insideCreativeComponent(node) {
  let current = node?.parentElement ?? null; let depth = 0;
  while (current && depth++ < 8) {
    if (/creative/i.test(String(current.localName ?? ''))) return true;
    current = current.parentElement ?? null;
  }
  return false;
}

function cardFields(node) {
  return {
    headline: cleanInline(first(node, 'h1,h2,h3,[role="heading"]')?.textContent) || null,
    description: cleanInline(first(node, '[aria-label*="description" i],p')?.textContent) || null,
    display_url: cleanInline(first(node, 'cite,[aria-label*="display" i]')?.textContent) || null
  };
}

function selectMinimalCard(anchor) {
  const anchorId = creativeId(hrefOf(anchor)); const anchorText = cleanInline(anchor.innerText ?? anchor.textContent); let current = anchor.parentElement ?? null;
  let evidenceOnly = null; let ambiguousIframe = null;
  while (current) {
    const tag = String(current.localName ?? '').toLowerCase();
    if (tag === 'html' || tag === 'body') break;
    const ids = nodeCreativeIds(current);
    if (ids.length >= 2) break;
    if (ids.length === 1 && ids[0] === anchorId) {
      const iframes = query(current, 'iframe[src]'); const fields = cardFields(current);
      const cardText = cleanMultiline(current.innerText ?? current.textContent);
      const hasSpecificEvidence = Boolean(fields.headline || fields.description || fields.display_url || (cardText && cardText !== anchorText));
      const candidate = { node: current, ids, iframes, cardText, fields };
      if (iframes.length === 1) return candidate;
      if (iframes.length > 1) ambiguousIframe ??= { ...candidate, warning: 'ambiguous_card_iframes' };
      if (hasSpecificEvidence) evidenceOnly ??= candidate;
    }
    current = current.parentElement ?? null;
  }
  if (ambiguousIframe) return ambiguousIframe;
  if (evidenceOnly) return { ...evidenceOnly, warning: 'evidence_only_card' };
  return { node: anchor, ids: anchorId ? [anchorId] : [], iframes: [], cardText: '', fields: { headline: null, description: null, display_url: null }, warning: 'atomic_card_container_not_found' };
}

export function creativeOcrTargets(doc, creativeIds = []) {
  const wanted = new Set((creativeIds ?? []).map(String)); const seen = new Set(); const targets = [];
  const walked = walkOpenDom(doc, { max_nodes: 8000, max_depth: 14 });
  for (const { node } of walked.records) {
    if (!visible(node) || !node.matches?.(CREATIVE_SELECTOR)) continue;
    const id = creativeId(hrefOf(node));
    if (!id || seen.has(id) || (wanted.size && !wanted.has(id))) continue;
    const card = selectMinimalCard(node); const target = card.node ?? node;
    if (!target?.getBoundingClientRect || !target?.scrollIntoView) continue;
    seen.add(id); targets.push({ creative_id: id, node: target });
  }
  return targets;
}

function profileRecords(walked, sourceUrl) {
  const records = []; const seen = new Set(); const regionCode = (() => { try { return new URL(sourceUrl).searchParams.get('region'); } catch { return null; } })();
  for (const { node, scope_path, depth } of walked.records) {
    if (!visible(node)) continue;
    const multiline = cleanMultiline(node.innerText ?? node.textContent); const inline = cleanInline(multiline);
    const accessible = cleanInline([node.getAttribute?.('aria-label'), node.getAttribute?.('title'), node.getAttribute?.('role')].filter(Boolean).join(' '));
    const tag = String(node.localName ?? '').toLowerCase();
    const exactProfileLink = tag === 'a' && exactAdvertiserProfile(hrefOf(node), sourceUrl);
    const levelOneHeading = (tag === 'h1' || (node.getAttribute?.('role') === 'heading' && node.getAttribute?.('aria-level') === '1'))
      && !insideCreativeComponent(node);
    if ((exactProfileLink || levelOneHeading) && inline) {
      const identityKey = `identity:${exactProfileLink ? 'exact_profile_link' : 'level_one_heading'}:${inline}`;
      if (!seen.has(identityKey)) {
        seen.add(identityKey);
        records.push({
          scope_path: nodePath(node, scope_path), depth, role: 'advertiser_identity',
          semantic_label: exactProfileLink ? 'Advertiser breadcrumb identity' : 'Advertiser heading identity',
          identity_source: exactProfileLink ? 'exact_profile_link' : 'level_one_heading',
          visible_text: inline.slice(0, 300), text_lines: [inline.slice(0, 300)], value: inline.slice(0, 300),
          evidence_url: exactProfileLink ? absolute(hrefOf(node), sourceUrl) : sourceUrl
        });
      }
    }
    const isDetails = /advertiser details|thông tin chi tiết về nhà quảng cáo/i.test(`${accessible} ${inline}`);
    const isButtonLike = /button|filter|lọc|lựa chọn/i.test(`${node.localName ?? ''} ${node.getAttribute?.('role') ?? ''} ${accessible}`);
    const isRegion = isButtonLike && /region|khu vực/i.test(`${accessible} ${inline}`);
    const hasTotal = /\b[\d][\d.,\s]*\s*(?:ads|quảng cáo)\b/i.test(inline);
    if (!isDetails && !isRegion && !hasTotal) continue;
    const key = `${isDetails}:${isRegion}:${inline}`; if (seen.has(key)) continue; seen.add(key);
    records.push({
      scope_path: nodePath(node, scope_path), depth, role: isRegion ? 'region_filter' : isDetails ? 'advertiser_details' : 'reported_total',
      semantic_label: accessible || (isDetails ? 'Advertiser Details' : null), visible_text: multiline.slice(0, 4000),
      text_lines: multiline.split('\n').filter(Boolean), value: isRegion ? inline : null,
      region_code: isRegion ? regionCode : null, region_evidence: isRegion ? `${accessible || 'region control'} | ${sourceUrl}` : null
    });
  }
  return records;
}

function creativeRecords(walked, sourceUrl) {
  const pathByNode = new Map(walked.records.map((record) => [record.node, record.scope_path])); const anchors = [];
  for (const { node } of walked.records) if (visible(node) && node.matches?.(CREATIVE_SELECTOR)) anchors.push(node);
  const records = [];
  for (const anchor of [...new Set(anchors)]) {
    const href = absolute(hrefOf(anchor), sourceUrl); const id = creativeId(href); if (!href || !id) continue;
    const card = selectMinimalCard(anchor); const iframeUrls = unique(card.iframes.map((frame) => absolute(frame.getAttribute?.('src') ?? frame.src, sourceUrl)));
    const imageUrls = unique(query(card.node, 'img,source,video').flatMap((node) => {
      const values = [node.currentSrc, node.src, node.poster, node.getAttribute?.('data-src'),
        node.getAttribute?.('data-original'), node.getAttribute?.('data-lazy-src')];
      const srcset = node.srcset || node.getAttribute?.('srcset');
      if (srcset) values.push(...srcset.split(',').map((part) => part.trim().split(/\s+/)[0]));
      return values.map((value) => absolute(value, sourceUrl)).filter((value) => /^https:\/\//i.test(value || ''));
    })).slice(0, 8);
    const fieldCount = Object.values(card.fields).filter(Boolean).length;
    const warnings = card.warning ? [card.warning] : [];
    const cardScope = nodePath(card.node, pathByNode.get(card.node) ?? pathByNode.get(anchor) ?? 'document');
    records.push({
      creative_id: id, creative_url: href, scope_path: cardScope,
      card_text: card.cardText.slice(0, 1600), iframe_urls: iframeUrls, image_urls: imageUrls,
      headline: card.fields.headline, description: card.fields.description, display_url: card.fields.display_url,
      candidate_quality: { atomic: card.ids.length === 1 && iframeUrls.length === 1, unique_creative_ids: card.ids.length, iframe_count: iframeUrls.length, field_count: fieldCount, bounded_text: Boolean(card.cardText), global_text: false },
      field_provenance: Object.fromEntries(Object.entries(card.fields).filter(([, value]) => value).map(([key]) => [key, `${cardScope}:outer_card`])),
      warnings
    });
  }
  return records;
}

export function creativeSnapshotState(snapshot) {
  const ids = unique((snapshot?.records ?? []).flatMap((record) => record.creative_id ? [record.creative_id] : (record.anchors ?? []).map((anchor) => creativeId(anchor.href)))).sort();
  const frameRevisions = (snapshot?.frame_snapshots ?? []).map((frame) => `${frame.frame_id ?? '?'}:${frame.sequence ?? '?'}:${frame.content_fingerprint ?? fingerprint([frame.headline, frame.description, frame.display_url, frame.display_path, frame.creative_text].join('|'))}`).sort();
  const cardRevision = (snapshot?.records ?? []).filter((record) => record.creative_id).map((record) => `${record.creative_id}:${fingerprint([record.card_text, record.headline, record.description, record.display_url, ...(record.iframe_urls ?? []), ...(record.image_urls ?? [])].join('|'))}`).sort();
  const signature = fingerprint(JSON.stringify({ ids, frameRevisions, cardRevision }));
  return { creative_ids: ids, unique_count: ids.length, frame_revisions: frameRevisions, signature };
}

export function buildAdsTransparencySnapshot(doc, sourceUrl, frameSnapshots = [], limits = {}) {
  const walked = walkOpenDom(doc, limits);
  const records = [...profileRecords(walked, sourceUrl), ...creativeRecords(walked, sourceUrl)];
  const snapshot = { profile_url: sourceUrl, observed_at: limits.observed_at ?? new Date().toISOString(), records, frame_snapshots: frameSnapshots, warnings: walked.warnings, adapter: 'open-shadow-dom/1.2.1' };
  return { ...snapshot, snapshot_state: creativeSnapshotState(snapshot) };
}

export function findCreativeLoadAction(doc) {
  const walked = walkOpenDom(doc); const buttonPattern = /(?:show\s+more|load\s+more|more|xem\s+thêm|tải\s+thêm)/i;
  const buttonRecord = walked.records.find(({ node }) => node.matches?.('button') && visible(node) && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' && buttonPattern.test(cleanInline(`${node.getAttribute?.('aria-label') ?? ''} ${node.textContent ?? ''}`)));
  if (buttonRecord) { buttonRecord.node.click(); return { action: 'deep_load_more_click', scope_path: nodePath(buttonRecord.node, buttonRecord.scope_path), creative_count: nodeCreativeIds(buttonRecord.node.parentElement).length, evidence: cleanInline(buttonRecord.node.getAttribute?.('aria-label') ?? buttonRecord.node.textContent) }; }
  const candidates = walked.records.map((record) => {
    const node = record.node; const ids = nodeCreativeIds(node); const scrollable = Number(node.scrollHeight) > Number(node.clientHeight);
    return { ...record, node, ids, scrollable, score: scrollable ? ids.length * 1000 + Math.min(Number(node.scrollHeight) - Number(node.clientHeight), 999) : -1 };
  }).filter((item) => item.scrollable && item.ids.length && item.node?.scrollTo).sort((a, b) => b.score - a.score);
  const selected = candidates[0];
  if (selected) {
    const before = { top: Number(selected.node.scrollTop ?? 0), height: Number(selected.node.scrollHeight), client: Number(selected.node.clientHeight) };
    const target = Math.max(before.top + before.client, before.height - before.client);
    selected.node.scrollTo({ top: target, behavior: 'smooth' });
    return { action: 'creative_catalog_scroll', scope_path: nodePath(selected.node, selected.scope_path), creative_count: selected.ids.length, scroll_before: before, scroll_after: { requested_top: target, height: before.height, client: before.client }, evidence: String(selected.node.localName ?? 'container') };
  }
  globalThis.scrollTo?.({ top: doc.documentElement?.scrollHeight ?? 0, behavior: 'smooth' });
  return { action: 'window_scroll', evidence: 'No deep load-more or scrollable creative container found' };
}

export async function waitForCreativeDomChange({ doc, previous_state, take_snapshot, timeout_ms = 2500, poll_ms = 100, limits = {} }) {
  const capture = take_snapshot ?? (async () => buildAdsTransparencySnapshot(doc, doc.location?.href ?? globalThis.location?.href ?? '', [], limits));
  const baseline = previous_state ?? creativeSnapshotState(await capture()); const started = Date.now(); let currentSnapshot = await capture(); let currentState = creativeSnapshotState(currentSnapshot); let settled = false; let inspecting = false; const observers = [];
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (changed, reason, error = null) => { if (settled) return; settled = true; for (const observer of observers) observer.disconnect(); clearInterval(timer); if (error) reject(error); else resolve({ snapshot: currentSnapshot, state: currentState, changed, reason }); };
    const inspect = async () => {
      if (settled || inspecting) return; inspecting = true;
      try {
        currentSnapshot = await capture(); currentState = creativeSnapshotState(currentSnapshot);
        const idsChanged = currentState.unique_count !== baseline.unique_count || currentState.creative_ids.join('|') !== baseline.creative_ids.join('|');
        const revisionChanged = currentState.signature !== baseline.signature;
        if (idsChanged || revisionChanged) finish(true, idsChanged ? 'creative_ids_changed' : 'snapshot_revision_changed');
        else if (Date.now() - started >= timeout_ms) finish(false, 'timeout_no_change');
      } catch (error) { finish(false, 'snapshot_error', error); }
      finally { inspecting = false; }
    };
    if (globalThis.MutationObserver) {
      const walked = walkOpenDom(doc, limits); const targets = unique([doc.documentElement, ...walked.roots.map((item) => item.root?.host ? item.root : null)]);
      for (const target of targets) { if (!target) continue; const observer = new MutationObserver(inspect); observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true }); observers.push(observer); }
    }
    timer = setInterval(inspect, poll_ms); inspect();
  });
}
