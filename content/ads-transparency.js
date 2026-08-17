(async () => {
  const contentVersion = chrome.runtime.getManifest().version;
  const existingOverlay = document.querySelector('#discovery-helper');
  if (existingOverlay?.dataset.helperVersion === contentVersion) return;
  existingOverlay?.remove();
  await import(chrome.runtime.getURL('content/shared.js'));
  const parsers = await import(chrome.runtime.getURL('lib/parsers.mjs'));
  const live = await import(chrome.runtime.getURL('lib/live-dom.mjs'));
  const jobs = await import(chrome.runtime.getURL('lib/job-orchestrator.mjs'));
  const autocomplete = await import(chrome.runtime.getURL('lib/autocomplete-orchestrator.mjs'));
  const ui = globalThis.DiscoveryHelperUi; const root = await ui.mount('Discovery · Ads Transparency'); const controls = root.querySelector('[data-controls]');
  let context = await ui.message({ type: 'GET_DISCOVERY_SESSION' });
  let catcherCommand = (await ui.message({ type: 'GET_CATCHER_RESEARCH_COMMAND' })).command;
  let advertiserCommand = (await ui.message({ type: 'GET_ADVERTISER_COMMAND' })).command;
  const portfolioCommand = (await ui.message({ type: 'GET_PORTFOLIO_COMMAND' })).command;
  const contextLine = document.createElement('p'); contextLine.textContent = `Session: ${context.id} · source: ${portfolioCommand?.source_domain ?? context.selected_source_domain?.hostname ?? 'not selected'}`; controls.append(contextLine);
  const regionGuardKey = 'ads-discovery-anywhere-region-target';
  if (advertiserCommand?.automatic) {
    const regionNavigation = jobs.anywhereRegionNavigation(location.href, sessionStorage.getItem(regionGuardKey));
    if (regionNavigation.action === 'redirect') {
      sessionStorage.setItem(regionGuardKey, regionNavigation.target);
      location.replace(regionNavigation.target);
      return;
    }
    if (regionNavigation.action === 'blocked') {
      const message = 'Ads Transparency changed region after one guarded redirect; automatic collection paused.';
      if (advertiserCommand?.automatic) {
        await ui.message({
          type: 'ADVERTISER_CATCHER_FINISHED', job_id: advertiserCommand.job_id,
          catcher_run_id: advertiserCommand.catcher_run_id,
          result: { status: 'parser_error', error_code: 'region_changed', error_message: message,
            evidence: { current_url: location.href, required_url: regionNavigation.target } },
        });
      }
      ui.status(root, message, true);
      return;
    }
  }
  if (catcherCommand?.domain) {
    const instruction = document.createElement('p'); instruction.textContent = `Quét thủ công ${catcherCommand.domain}: bạn tự lọc hoặc bấm Show more. Helper chỉ gửi danh sách về Hi Auto sau khi bạn bấm “Xác nhận kết quả”.`; controls.append(instruction);
  }
  const profileButton = document.createElement('button'); profileButton.textContent = 'Lưu profile';
  const collectButton = document.createElement('button'); collectButton.textContent = 'Thu danh mục quảng cáo';
  const limit = document.createElement('input'); limit.type = 'number'; limit.min = '1'; limit.max = '50'; limit.value = '20'; limit.title = 'Safety batch limit';
  const profileIdentity = (value) => { try { const url = new URL(value); const id = url.pathname.match(/(?:^|\/)advertiser\/(AR\d+)(?:\/|$)/i)?.[1]; return id ? `${url.origin}/advertiser/${id}` : null; } catch { return null; } };
  controls.append(profileButton, collectButton, limit); let savedAdvertiserRowId = null; let savedExternalAdvertiserId = null; let lastProfileUrl = location.href; let lastProfileIdentity = profileIdentity(location.href); let profileGeneration = 0;
  const refreshContext = async () => { context = await ui.message({ type: 'GET_DISCOVERY_SESSION' }); return context; };
  const snapshot = async (limits = {}) => {
    const currentIdentity = profileIdentity(location.href);
    if (currentIdentity !== lastProfileIdentity) { await ui.message({ type: 'CLEAR_ADS_FRAME_CACHE' }); lastProfileUrl = location.href; lastProfileIdentity = currentIdentity; savedAdvertiserRowId = null; savedExternalAdvertiserId = null; profileGeneration++; }
    else if (location.href !== lastProfileUrl) { await ui.message({ type: 'CLEAR_ADS_FRAME_CACHE' }); lastProfileUrl = location.href; }
    const frames = await ui.message({ type: 'GET_ADS_FRAME_SNAPSHOTS', profile_url: location.href });
    return live.buildAdsTransparencySnapshot(document, location.href, frames.snapshots ?? [], {
      max_nodes: limits.max_nodes ?? 5000, max_depth: limits.max_depth ?? 12,
    });
  };
  let profileSavePromise = null;
  const saveCurrentProfile = () => {
    if (profileSavePromise) return profileSavePromise;
    profileSavePromise = (async () => {
      await refreshContext();
      if (!context.selected_source_domain_id) throw new Error('Select a confirmed catcher in the local wizard first.');
      const settled = await parsers.waitForAdsTransparencyProfile({
        take_snapshot: snapshot, timeout_ms: 10_000, poll_ms: 250,
        on_attempt: ({ attempts, profile }) => {
          if (attempts > 1 && profile.review_required) ui.status(root, 'Đang chờ thông tin nhà quảng cáo tải đầy đủ…');
        }
      });
      const parsed = settled.parsed;
      if (parsed.profile.review_required) {
        const error = new Error(`Profile requires review: ${parsed.profile.warnings.join(', ')}`);
        error.reviewRequired = true; error.profileWarnings = parsed.profile.warnings; throw error;
      }
      const batchCommand = advertiserCommand?.profile_queue?.length
        ? advertiserCommand : catcherCommand?.profile_queue?.length ? catcherCommand : null;
      const result = await ui.message({ type: 'SAVE_ADVERTISER_PROFILE', payload: {
        source_domain_id: context.selected_source_domain_id, profile: parsed.profile,
        observed_at: new Date().toISOString(), job_id: advertiserCommand?.job_id ?? null,
        catcher_run_id: advertiserCommand?.catcher_run_id ?? null,
        defer_catcher_completion: Boolean(batchCommand),
      } });
      savedAdvertiserRowId = result.id; savedExternalAdvertiserId = parsed.profile.advertiser_id; ui.status(root, `Saved ${result.advertiser_name ?? result.advertiser_id} for ${context.selected_source_domain.hostname}.`);
      if (batchCommand) {
        const advanced = await ui.message({
          type: 'ADVERTISER_BATCH_PROFILE_SAVED', advertiser_id: parsed.profile.advertiser_id,
        });
        if (!advanced.done) ui.status(root, `Đã lưu ${advanced.index}/${advanced.total}; đang mở advertiser tiếp theo.`);
        else ui.status(root, `Đã lưu đủ ${advanced.total} advertiser cho ${context.selected_source_domain.hostname}.`);
      } else if (catcherCommand?.domain) {
        await ui.message({ type: 'CLEAR_CATCHER_RESEARCH_COMMAND' });
        await ui.message({ type: 'CLOSE_LEGACY_WORK_TAB' });
      } else if (advertiserCommand?.automatic) {
        await ui.message({
          type: 'ADVERTISER_CATCHER_FINISHED', job_id: advertiserCommand.job_id,
          catcher_run_id: advertiserCommand.catcher_run_id,
          result: { status: 'advertiser_found', advertiser_id: parsed.profile.advertiser_id, ...result },
        });
      }
      return result;
    })().finally(() => { profileSavePromise = null; });
    return profileSavePromise;
  };
  profileButton.addEventListener('click', async () => {
    if (profileButton.disabled) return; profileButton.disabled = true;
    try { await saveCurrentProfile(); }
    catch (error) { ui.status(root, error.message, true); }
    finally { profileButton.disabled = false; }
  });
  collectButton.addEventListener('click', async () => {
    if (collectButton.disabled) return; collectButton.disabled = true;
    try {
      await refreshContext(); const preflightSnapshot = await snapshot(); const preflight = parsers.parseAdsTransparencySnapshot(preflightSnapshot); const generation = profileGeneration; const collectionProfileUrl = location.href; const collectionProfileIdentity = profileIdentity(collectionProfileUrl); const filterUrls = new Set([collectionProfileUrl]);
      if (!savedAdvertiserRowId) throw new Error('Click “Lưu profile” first.');
      if (!savedExternalAdvertiserId || preflight.profile.advertiser_id !== savedExternalAdvertiserId) throw new Error('Saved advertiser no longer matches the current Ads Transparency profile. Save profile again.');
      const first = preflight;
      let previousCreativeIds = new Set(first.creatives.map((creative) => creative.creative_external_id));
      let previousSnapshotSignature = null;
      let previousUniqueCount = previousCreativeIds.size;
      const collection = await parsers.collectCreativeBatches({ advertiser_id: first.profile.advertiser_id, reported_total: first.profile.reported_total, max_batches: Math.min(50, Math.max(1, Number(limit.value))), load_batch: async (index) => {
        if (profileGeneration !== generation || profileIdentity(location.href) !== collectionProfileIdentity) throw new Error('Ads Transparency advertiser changed during collection; collection aborted.');
        const beforeSnapshot = await snapshot(); const beforeState = live.creativeSnapshotState(beforeSnapshot); let currentSnapshot = beforeSnapshot;
        let batchEvidence = { action: index === 0 ? 'initial_snapshot' : null, wait_reason: index === 0 ? 'not_applicable' : null };
        if (index > 0) {
          const action = live.findCreativeLoadAction(document);
          const waited = await live.waitForCreativeDomChange({ doc: document, previous_state: beforeState, take_snapshot: snapshot, timeout_ms: 2500 });
          currentSnapshot = waited.snapshot; batchEvidence = { ...action, wait_reason: waited.reason, changed: waited.changed };
        }
        filterUrls.add(location.href); const currentState = live.creativeSnapshotState(currentSnapshot);
        const comparedTo = { creative_ids: [...previousCreativeIds], snapshot_signature: previousSnapshotSignature, unique_count: previousUniqueCount };
        previousCreativeIds = new Set(currentState.creative_ids); previousSnapshotSignature = currentState.signature; previousUniqueCount = currentState.unique_count;
        const parsed = parsers.parseAdsTransparencySnapshot({ ...currentSnapshot, batch_evidence: batchEvidence });
        if (parsed.profile.advertiser_id !== savedExternalAdvertiserId || profileIdentity(parsed.profile.profile_url) !== collectionProfileIdentity) throw new Error('Ads Transparency advertiser changed during collection; collection aborted.');
        const withText = parsed.creatives.filter((item) => item.quality_status !== 'partial').length; const partial = parsed.creatives.length - withText; const exact = parsed.creatives.filter((item) => item.frame_mapping_state === 'observed').length;
        ui.status(root, `batch ${index + 1} · ${batchEvidence.action ?? 'snapshot'} · ${batchEvidence.wait_reason ?? 'pending'} · unique ${parsed.creatives.length} · with text ${withText} · partial ${partial} · exact ${exact} / unknown ${parsed.creatives.length - exact}`);
        return { ...parsed, batch_evidence: { ...batchEvidence, compared_to: comparedTo, current: { creative_ids: [...previousCreativeIds], snapshot_signature: previousSnapshotSignature, unique_count: previousUniqueCount } } };
      }});
      await refreshContext(); if (profileGeneration !== generation || profileIdentity(location.href) !== collectionProfileIdentity) throw new Error('Ads Transparency advertiser changed before save; collection aborted.');
      filterUrls.add(location.href); const filterContextChanged = filterUrls.size > 1;
      if (filterContextChanged) { collection.truncated = true; collection.stop_reason = parsers.REASON_CODES.FILTER_CONTEXT_CHANGED; }
      const result = await ui.message({ type: 'SAVE_CREATIVE_COLLECTION', payload: { advertiser_row_id: savedAdvertiserRowId, advertiser_id: savedExternalAdvertiserId, profile_url: collectionProfileUrl, collection, region_filter: first.profile.region_filter, initial_filter_url: collectionProfileUrl, final_filter_url: location.href, filter_context_changed: filterContextChanged, observed_at: new Date().toISOString(), parser_version: parsers.PARSER_VERSION } });
      ui.status(root, `reported=${collection.reported_total ?? '?'} unique=${collection.unique_cards_discovered} improved=${collection.improved_count} with_text=${collection.creatives_with_text} partial=${collection.partial_count} exact/unknown=${collection.creatives.filter((item) => item.frame_mapping_state === 'observed').length}/${collection.creatives.filter((item) => item.frame_mapping_state === 'unknown').length} batches=${collection.pages_or_batches} truncated=${collection.truncated} stop=${collection.stop_reason}; projects=${result.projects.length}`, collection.truncated);
      await ui.message({ type: 'CLOSE_LEGACY_WORK_TAB' });
    } catch (error) { ui.status(root, error.message, true); } finally { collectButton.disabled = false; }
  });

  const startManualPortfolioScan = async (queued) => {
    const expectedIdentity = profileIdentity(queued.profile_url);
    if (!expectedIdentity || expectedIdentity !== profileIdentity(location.href)
        || !expectedIdentity.endsWith(`/advertiser/${queued.advertiser_id}`)) {
      throw new Error('Queued advertiser profile does not match this Ads Transparency document.');
    }
    profileButton.hidden = true; collectButton.hidden = true; limit.hidden = true;
    let snapshotTaken = Boolean(queued.manual_snapshot_taken);
    let creatives = snapshotTaken
      ? parsers.mergeManualCreativeObservations([], queued.manual_creatives ?? []) : [];
    let latestProfile = snapshotTaken ? queued.manual_profile ?? null : null;
    let observations = snapshotTaken ? Number(queued.manual_observations) || 0 : 0;
    const filterUrls = new Set(queued.manual_filter_urls ?? [location.href]);
    let scanRunning = false; let confirming = false; let cancelRequested = false; let lastRenderKey = null;
    const scanButton = document.createElement('button'); scanButton.textContent = '1 · Quét hiện trạng';
    const confirmButton = document.createElement('button');
    confirmButton.disabled = !snapshotTaken;
    const cancelButton = document.createElement('button'); cancelButton.textContent = 'Hủy lượt quét';
    controls.append(scanButton, confirmButton, cancelButton);
    const render = (blocked = null) => {
      const complete = creatives.filter((item) => item.quality_status !== 'partial'
        && (item.creative_text || item.headline || item.description)).length;
      const assetCount = creatives.reduce((total, item) => total + (item.image_urls?.length ?? 0), 0);
      const ocrTargetCount = creatives.filter((item) => item.image_urls?.length).length;
      const unusableCount = creatives.filter((item) => !item.image_urls?.length
        && !item.landing_url && !item.display_url).length;
      const renderKey = `${snapshotTaken}:${observations}:${creatives.length}:${complete}:${assetCount}:${ocrTargetCount}:${unusableCount}:${blocked?.code ?? blocked ?? ''}`;
      if (renderKey === lastRenderKey) return;
      lastRenderKey = renderKey; confirmButton.textContent = `2 · Xác nhận & OCR (${ocrTargetCount})`;
      ui.status(root, blocked
        ? `Đang giữ ${creatives.length} creative. Hãy xử lý CAPTCHA rồi tiếp tục; chưa gửi dữ liệu về Hi Auto.`
        : snapshotTaken
          ? `Đã chốt hiện trạng: ${creatives.length} creative · ${ocrTargetCount} có ảnh để OCR · ${complete} đủ nội dung${unusableCount ? ` · ${unusableCount} thiếu cả ảnh/URL sẽ tự bỏ qua` : ''}. Khi xác nhận, Hi Auto tải ảnh về máy rồi OCR file local.`
          : `Chưa quét. Hãy lọc ngày và Show more theo ý bạn trước, sau đó bấm “1 · Quét hiện trạng”. Tool không tự thu quảng cáo cũ.`, Boolean(blocked));
    };
    const persist = () => ui.message({ type: 'UPDATE_PORTFOLIO_SCAN',
      advertiser_id: queued.advertiser_id, creatives, profile: latestProfile,
      observations, filter_urls: [...filterUrls], snapshot_taken: snapshotTaken });
    const scan = async ({ replace = false } = {}) => {
      if (scanRunning) return;
      scanRunning = true;
      try {
        const blocked = jobs.detectBlockedPage({
          url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 5000),
        });
        if (blocked) { render(blocked); return; }
        if (profileIdentity(location.href) !== expectedIdentity) {
          ui.status(root, `Bạn đã rời profile ${queued.advertiser_id}. Hãy quay lại để tiếp tục; dữ liệu đã quét vẫn được giữ.`, true);
          return;
        }
        const parsed = parsers.parseAdsTransparencySnapshot(await snapshot({ max_nodes: 30_000, max_depth: 16 }));
        if (parsed.profile.advertiser_id !== queued.advertiser_id) {
          ui.status(root, 'Đang chờ thông tin đúng advertiser tải đầy đủ…', true); return;
        }
        creatives = parsers.mergeManualCreativeObservations(replace ? [] : creatives, parsed.creatives);
        latestProfile = parsed.profile; observations += 1;
        if (replace) filterUrls.clear();
        filterUrls.add(location.href);
        snapshotTaken = true;
        confirmButton.disabled = false;
        await persist();
        render();
      } catch (error) { ui.status(root, error.message, true); }
      finally { scanRunning = false; }
    };
    const ocrMissingCreatives = async () => {
      const targets = creatives.filter((item) => Array.isArray(item.image_urls) && item.image_urls.length);
      const unresolvedWithoutAssets = creatives.filter((item) => !item.landing_url && !item.display_url
        && (!Array.isArray(item.image_urls) || !item.image_urls.length));
      if (!targets.length) return { job_id: null, requested: 0, targets: 0, read: 0,
        failed: unresolvedWithoutAssets.length, without_assets: unresolvedWithoutAssets.length,
        skipped_creative_ids: unresolvedWithoutAssets.map((item) => item.creative_external_id),
        errors: unresolvedWithoutAssets.map((item) => `${item.creative_external_id}: không có URL ảnh gốc hoặc landing/display URL`).slice(0, 8) };
      const started = await ui.message({ type: 'PORTFOLIO_OCR_BATCH_START',
        advertiser_id: queued.advertiser_id,
        creatives: targets.map((item) => ({ creative_id: item.creative_external_id,
          asset_urls: item.image_urls })) });
      let job = started.job;
      const terminal = new Set(['ready_to_sync', 'failed', 'cancelled']);
      while (!terminal.has(job.stage)) {
        if (cancelRequested) {
          await ui.message({ type: 'PORTFOLIO_OCR_BATCH_CANCEL', job_id: job.job_id }).catch(() => null);
          throw new Error('Đã dừng job OCR nền. Ảnh đã tải và cache OCR hợp lệ vẫn được giữ để lần sau không làm lại.');
        }
        const counts = job.counts ?? {};
        ui.status(root, job.stage === 'downloading'
          ? `1/3 · Đang tải toàn bộ ảnh về máy: ${counts.download_done || 0}/${counts.creatives || targets.length} creative · ${counts.downloaded_assets || 0} file.`
          : job.stage === 'downloaded'
            ? `1/3 · Đã tải xong ${counts.downloaded_assets || 0} file · đang chuyển sang OCR local.`
            : job.stage === 'ocr'
              ? `2/3 · Tesseract đang OCR file local: ${counts.ocr_done || 0}/${counts.downloaded_creatives || targets.length} · đọc được ${counts.ocr_read || 0}.`
              : 'Đang xếp job OCR nền trong Hi Auto…');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        job = (await ui.message({ type: 'PORTFOLIO_OCR_BATCH_STATUS', job_id: job.job_id })).job;
      }
      if (job.stage === 'failed') throw new Error(`Job OCR nền lỗi: ${job.error || 'không có chi tiết'}`);
      if (job.stage === 'cancelled') throw new Error('Job OCR nền đã được hủy.');
      ui.status(root, `3/3 · OCR xong ${job.counts?.ocr_read || 0}/${job.counts?.ocr_done || targets.length} creative · đang đồng bộ kết quả về Hi Auto…`);
      job = (await ui.message({ type: 'PORTFOLIO_OCR_BATCH_STATUS', job_id: job.job_id,
        include_items: true })).job;
      const errors = [];
      for (const result of job.items ?? []) {
        const at = creatives.findIndex((item) => item.creative_external_id === result.creative_id);
        if (at < 0) continue;
        const assets = result.assets ?? [];
        if (result.ocr_status !== 'read' || !result.ocr_text) {
          const reason = result.ocr_errors?.[0]?.error || result.download_errors?.[0]?.error
            || 'Tesseract không thấy chữ trong ảnh gốc';
          errors.push(`${result.creative_id}: ${reason}`);
          creatives[at] = { ...creatives[at], ocr_status: result.ocr_status || 'failed',
            ocr_source: 'original_asset', ocr_error: reason.slice(0, 200),
            ocr_asset_urls: assets.map((asset) => asset.asset_url),
            ocr_asset_sha256: assets.map((asset) => asset.sha256),
            ocr_asset_cache_keys: assets.map((asset) => asset.cache_key) };
          continue;
        }
        creatives[at] = { ...creatives[at], creative_text: creatives[at].creative_text || result.ocr_text,
          ocr_text: result.ocr_text, ocr_confidence: result.ocr_confidence, ocr_status: 'read',
          ocr_source: 'original_asset', ocr_asset_urls: assets.map((asset) => asset.asset_url),
          ocr_asset_sha256: assets.map((asset) => asset.sha256),
          ocr_asset_cache_keys: assets.map((asset) => asset.cache_key),
          quality_status: 'complete', quality_reason: null,
          field_provenance: { ...(creatives[at].field_provenance ?? {}),
            creative_text: creatives[at].creative_text
              ? creatives[at].field_provenance?.creative_text : 'local_tesseract_original_asset' } };
      }
      for (const item of unresolvedWithoutAssets) errors.push(`${item.creative_external_id}: không có URL ảnh gốc hoặc landing/display URL`);
      return { job_id: job.job_id, requested: targets.length, targets: targets.length,
        read: Number(job.counts?.ocr_read || 0),
        failed: Number(job.counts?.ocr_empty || 0) + Number(job.counts?.ocr_failed || 0) + unresolvedWithoutAssets.length,
        without_assets: unresolvedWithoutAssets.length,
        skipped_creative_ids: unresolvedWithoutAssets.map((item) => item.creative_external_id),
        errors: errors.slice(0, 8) };
    };
    scanButton.addEventListener('click', async () => {
      scanButton.disabled = true; confirmButton.disabled = true;
      try { await scan({ replace: true }); }
      finally { scanButton.disabled = false; confirmButton.disabled = !snapshotTaken; }
    });
    confirmButton.addEventListener('click', async () => {
      confirming = true; cancelRequested = false;
      scanButton.disabled = true; confirmButton.disabled = true; cancelButton.disabled = false;
      cancelButton.textContent = 'Dừng OCR';
      while (scanRunning) await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        if (!snapshotTaken) throw new Error('Hãy bấm “1 · Quét hiện trạng” sau khi lọc ngày trước.');
        if (!latestProfile || latestProfile.advertiser_id !== queued.advertiser_id) {
          throw new Error('Thông tin advertiser chưa tải đủ để xác nhận.');
        }
        const ocr = await ocrMissingCreatives();
        if (ocr.targets === 0 && ocr.without_assets > 0) {
          throw new Error(`Cả ${ocr.without_assets} creative đều thiếu URL ảnh gốc và URL đích; không có dữ liệu hợp lệ để lưu.`);
        }
        if (ocr.targets > 0 && ocr.read === 0) {
          throw new Error(`OCR thất bại 0/${ocr.targets}: ${ocr.errors.join(' · ') || 'không có chi tiết'}`);
        }
        await refreshContext();
        const sourceCatcherId = portfolioCommand?.source_catcher_id ?? context.selected_source_domain_id;
        if (!sourceCatcherId) throw new Error('Hi Auto chưa chọn domain nguồn cho advertiser này.');
        const saved = await ui.message({ type: 'SAVE_ADVERTISER_PROFILE', payload: {
          source_domain_id: sourceCatcherId, profile: latestProfile,
          observed_at: new Date().toISOString(),
        } });
        const skippedIds = new Set(ocr.skipped_creative_ids ?? []);
        const usableCreatives = creatives.filter((item) => !skippedIds.has(item.creative_external_id));
        const collection = parsers.manualCreativeCollection({
          creatives: usableCreatives, reported_total: latestProfile.reported_total,
          observations, filter_urls: [...filterUrls],
        });
        collection.ocr = ocr;
        const result = await ui.message({ type: 'SAVE_CREATIVE_COLLECTION', payload: {
          advertiser_row_id: saved.id, advertiser_id: queued.advertiser_id,
          source_catcher_id: sourceCatcherId,
          profile_url: queued.profile_url, collection,
          region_filter: latestProfile.region_filter, initial_filter_url: queued.profile_url,
          final_filter_url: location.href, filter_context_changed: filterUrls.size > 1,
          observed_at: new Date().toISOString(), parser_version: parsers.PARSER_VERSION,
        } });
        if (ocr.job_id) await ui.message({ type: 'PORTFOLIO_OCR_BATCH_SYNCED', job_id: ocr.job_id });
        await ui.message({ type: 'CONFIRM_PORTFOLIO_SCAN', advertiser_id: queued.advertiser_id,
          creative_count: collection.unique_cards_discovered, project_count: result.projects.length,
          traffic_ready_count: result.traffic_ready_count ?? 0,
          traffic_queued_count: result.handoff?.traffic?.inserted ?? 0,
          handoff_status: result.handoff?.status ?? null,
          handoff_error: result.handoff?.error ?? null });
        const handoffIssue = result.handoff?.error;
        const skippedNote = ocr.without_assets ? ` · đã bỏ qua ${ocr.without_assets} creative thiếu cả ảnh/URL` : '';
        ui.status(root, handoffIssue
          ? `Đã OCR ${ocr.read}/${ocr.targets} ảnh và lưu ${result.projects.length} dự án${skippedNote}. Chưa xếp được hàng traffic: ${handoffIssue}`
          : `Đã OCR ${ocr.read}/${ocr.targets} ảnh và gửi ${collection.unique_cards_discovered} creative${skippedNote} · ${result.projects.length} dự án · ${result.traffic_ready_count ?? 0} domain · ${result.handoff?.traffic?.inserted ?? 0} dự án đã xếp hàng traffic. Tab được giữ nguyên.`, Boolean(handoffIssue));
        confirming = false; cancelButton.disabled = true;
      } catch (error) {
        confirming = false; cancelButton.textContent = 'Hủy lượt quét';
        scanButton.disabled = false; confirmButton.disabled = !snapshotTaken; cancelButton.disabled = false;
        ui.status(root, error.message, true);
      }
    });
    cancelButton.addEventListener('click', async () => {
      if (confirming) {
        cancelRequested = true; cancelButton.disabled = true;
        ui.status(root, 'Đang dừng an toàn sau ảnh hiện tại; chưa gửi kết quả về Hi Auto.');
        return;
      }
      scanButton.disabled = true; confirmButton.disabled = true; cancelButton.disabled = true;
      await ui.message({ type: 'CANCEL_PORTFOLIO_SCAN', advertiser_id: queued.advertiser_id });
      ui.status(root, 'Đã hủy lượt quét dự án. Không gửi creative nào về Hi Auto.');
    });
    render();
  };

  const finishAutomatic = async (status, details = {}) => ui.message({
    type: 'ADVERTISER_CATCHER_FINISHED', job_id: advertiserCommand.job_id,
    catcher_run_id: advertiserCommand.catcher_run_id,
    result: { status, error_code: details.error_code ?? status,
      error_message: details.error_message ?? null, evidence: details.evidence ?? {} },
  });
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const advertiserLinks = () => [...document.querySelectorAll('a[href*="/advertiser/AR"]')].map((anchor) => ({
    href: anchor.href, text: anchor.textContent?.trim() ?? '',
    evidence: anchor.closest('article,li,[role="listitem"],div')?.innerText?.slice(0, 2000) ?? anchor.textContent ?? '',
  }));
  const ADVERTISER_RESULT_TIMEOUT_MS = 15_000;
  const FILTER_MIN_DWELL_MS = 6_000;
  const RESULT_MIN_DWELL_MS = 5_000;
  const RESULT_STABLE_MS = 2_500;
  const EMPTY_MIN_DWELL_MS = 8_000;
  const candidateSignature = (candidates) => candidates
    .map((candidate) => `${candidate.advertiser_id ?? ''}:${candidate.profile_url ?? candidate.href ?? ''}`)
    .sort().join('|');
  const waitForFilteredAdvertisers = async (deadline) => {
    const startedAt = Date.now();
    let candidates = []; let lastSignature = null; let stableSince = startedAt;
    while (Date.now() < deadline) {
      const blocked = jobs.detectBlockedPage({
        url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 5000),
      });
      if (blocked) return { blocked, candidates: [] };
      candidates = jobs.collectAdvertiserCandidates(advertiserLinks(), 50);
      const now = Date.now(); const signature = candidateSignature(candidates);
      if (signature !== lastSignature) {
        lastSignature = signature; stableSince = now;
        document.scrollingElement?.scrollTo?.({ top: document.scrollingElement.scrollHeight });
      } else if (candidates.length && now - startedAt >= FILTER_MIN_DWELL_MS
          && now - stableSince >= RESULT_STABLE_MS) {
        return { candidates };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { candidates, timeout: !candidates.length };
  };
  const waitForSearchOutcome = async (deadline) => {
    const startedAt = Date.now();
    let lastSignature = null; let resultStableSince = startedAt; let emptyStableSince = null;
    while (Date.now() < deadline) {
      const blocked = jobs.detectBlockedPage({ url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 5000) });
      if (blocked) return { blocked, links: [] };
      const now = Date.now(); const links = advertiserLinks(); const signature = candidateSignature(links);
      if (signature !== lastSignature) {
        lastSignature = signature; resultStableSince = now;
      }
      if (links.length && now - startedAt >= RESULT_MIN_DWELL_MS
          && now - resultStableSince >= RESULT_STABLE_MS) return { blocked: null, links };
      const text = document.body?.innerText?.toLowerCase() ?? '';
      const explicitEmpty = /no (?:advertisers?|ads?|results?) found|không tìm thấy/.test(text);
      if (explicitEmpty && !links.length) {
        emptyStableSince ??= now;
        if (now - startedAt >= EMPTY_MIN_DWELL_MS && now - emptyStableSince >= RESULT_STABLE_MS) {
          return { blocked: null, links: [], empty: true };
        }
      } else {
        emptyStableSince = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { timeout: true, links: [] };
  };
  const waitForSuggestionEffect = async (deadline, selectedElement, initialUrl) => {
    let emptyScans = 0;
    while (Date.now() < deadline) {
      const blocked = jobs.detectBlockedPage({ url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 5000) });
      if (blocked) return { changed: true, blocked };
      const links = advertiserLinks();
      if (links.length) return { changed: true, links, signal: 'advertiser_result' };
      const text = document.body?.innerText?.toLowerCase() ?? '';
      if (/no (?:advertisers?|ads?|results?) found|không tìm thấy/.test(text)) {
        return { changed: true, links: [], empty: true, signal: 'explicit_empty_state' };
      }
      if (location.href !== initialUrl) return { changed: true, signal: 'url_changed' };
      const candidates = autocomplete.discoverSuggestionCandidates(document);
      if (!selectedElement?.isConnected && candidates.length) {
        return { changed: false, detached: true };
      }
      emptyScans = candidates.length ? 0 : emptyScans + 1;
      if (emptyScans >= 2) return { changed: true, signal: 'dropdown_closed' };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { changed: false };
  };
  const manualSuggestionReview = async (domain, decision, message) => finishAutomatic('needs_manual_review', {
    error_code: decision.status === 'ambiguous' ? 'ambiguous_exact_suggestions' : 'exact_suggestion_not_found',
    error_message: message,
    evidence: { domain, candidates: decision.candidates ?? [] },
  });
  const selectExactSuggestion = async (input, domain, initialDecision) => {
    let decision = initialDecision; let rescanned = false; const initialUrl = location.href;
    const clickDeadline = Date.now() + 10_000;
    const rescanOnce = async () => {
      if (rescanned) return null;
      rescanned = true;
      return autocomplete.waitForExactSuggestion({ root: document, catcherDomain: domain, timeoutMs: 1_000, pollMs: 100 });
    };
    if (!autocomplete.visibleSuggestionElement(decision.candidate?.element)) decision = await rescanOnce();
    if (!decision || decision.status !== 'unique') return { failed: 'detached', decision };
    let selectedElement = decision.candidate.element;
    let dispatched = autocomplete.dispatchSuggestionInteraction(selectedElement);
    if (!dispatched.clicked) {
      decision = await rescanOnce();
      if (!decision || decision.status !== 'unique') return { failed: 'detached', decision };
      selectedElement = decision.candidate.element;
      dispatched = autocomplete.dispatchSuggestionInteraction(selectedElement);
    }
    let effect = await waitForSuggestionEffect(Math.min(clickDeadline, Date.now() + 1_200), selectedElement, initialUrl);
    if (!effect.changed && autocomplete.shouldRescanDetachedSuggestion({ detached: effect.detached, rescanUsed: rescanned })) {
      decision = await rescanOnce();
      if (!decision || decision.status !== 'unique') return { failed: 'detached', decision };
      selectedElement = decision.candidate.element;
      autocomplete.dispatchSuggestionInteraction(selectedElement);
      effect = await waitForSuggestionEffect(Math.min(clickDeadline, Date.now() + 1_200), selectedElement, initialUrl);
    }
    if (!effect.changed && autocomplete.visibleSuggestionElement(selectedElement)) {
      selectedElement.click?.();
      effect = await waitForSuggestionEffect(Math.min(clickDeadline, Date.now() + 1_000), selectedElement, initialUrl);
    }
    if (!effect.changed) {
      const fallbackDecision = autocomplete.exactSuggestionDecision(
        autocomplete.discoverSuggestionCandidates(document), domain,
      );
      if (autocomplete.canUseSuggestionKeyboardFallback(fallbackDecision, effect.changed)) {
        autocomplete.dispatchExactSuggestionKeyboardFallback(input);
        effect = await waitForSuggestionEffect(clickDeadline, fallbackDecision.candidate.element, initialUrl);
      }
    }
    return effect.changed ? { effect, deadline: clickDeadline } : { failed: 'suggestion_click_failed', decision };
  };
  let manualScanObserver = null; let manualScanPersistTimer = null;
  const runCatcherResearch = async () => {
    catcherCommand = (await ui.message({ type: 'GET_CATCHER_RESEARCH_COMMAND' })).command;
    if (!catcherCommand?.domain || advertiserCommand?.automatic) return;
    await refreshContext();
    if (catcherCommand.session_id !== context.id) {
      throw new Error('Catcher research command/session identity mismatch.');
    }
    if (context.selected_source_domain?.hostname !== catcherCommand.domain) {
      throw new Error(`Hi Auto chưa chọn đúng catcher ${catcherCommand.domain}. Hãy bấm tìm lại từ đúng dòng dự án.`);
    }
    if (/^\/advertiser\/AR\d+(?:\/|$)/.test(location.pathname)) {
      ui.status(root, `Đang ở một profile. Hãy quay lại danh sách ${catcherCommand.domain}; kết quả đã quét vẫn được giữ.`);
      return;
    }
    if (manualScanObserver) return;
    profileButton.hidden = true; collectButton.hidden = true; limit.hidden = true;
    const profiles = new Map((catcherCommand.manual_profiles ?? [])
      .map((item) => [item.advertiser_id, item]));
    let lastRenderKey = null;
    const confirmButton = document.createElement('button');
    const cancelButton = document.createElement('button'); cancelButton.textContent = 'Hủy lượt quét';
    controls.append(confirmButton, cancelButton);
    const render = () => {
      confirmButton.textContent = `Xác nhận kết quả (${profiles.size})`;
      const blocked = jobs.detectBlockedPage({
        url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 5000),
      });
      const renderKey = `${profiles.size}:${blocked?.code ?? blocked ?? ''}`;
      if (renderKey === lastRenderKey) return;
      lastRenderKey = renderKey;
      ui.status(root, blocked
        ? `Đang giữ ${profiles.size} advertiser. Hãy xử lý CAPTCHA rồi tiếp tục; chưa có kết quả nào được gửi.`
        : `Đang quét thủ công ${catcherCommand.domain}: đã ghi nhận ${profiles.size} advertiser. Bạn có thể lọc hoặc bấm Show more, sau đó bấm “Xác nhận kết quả”.`, Boolean(blocked));
    };
    const currentProfiles = () => [...profiles.values()];
    const persist = () => {
      clearTimeout(manualScanPersistTimer);
      manualScanPersistTimer = setTimeout(() => {
        ui.message({ type: 'UPDATE_CATCHER_RESEARCH_SCAN', domain: catcherCommand.domain,
          profiles: currentProfiles() }).catch((error) => ui.status(root, error.message, true));
      }, 400);
    };
    const scan = () => {
      let changed = false;
      for (const item of jobs.collectAdvertiserCandidates(advertiserLinks(), 50)) {
        if (profiles.size >= 50) break;
        if (profiles.has(item.advertiser_id)) continue;
        profiles.set(item.advertiser_id, item); changed = true;
      }
      if (changed) persist();
      render();
    };
    manualScanObserver = new MutationObserver(scan);
    manualScanObserver.observe(document.body, { childList: true, subtree: true });
    confirmButton.addEventListener('click', async () => {
      confirmButton.disabled = true; cancelButton.disabled = true;
      scan(); clearTimeout(manualScanPersistTimer); manualScanObserver?.disconnect();
      try {
        const result = await ui.message({ type: 'CONFIRM_CATCHER_RESEARCH_SCAN',
          domain: catcherCommand.domain, profiles: currentProfiles() });
        catcherCommand = null; manualScanObserver = null;
        ui.status(root, `Đã xác nhận và gửi ${result.saved_count} advertiser về Hi Auto. Tab này được giữ nguyên để đối chiếu.`);
      } catch (error) {
        confirmButton.disabled = false; cancelButton.disabled = false;
        manualScanObserver?.observe(document.body, { childList: true, subtree: true });
        ui.status(root, error.message, true);
      }
    });
    cancelButton.addEventListener('click', async () => {
      confirmButton.disabled = true; cancelButton.disabled = true;
      clearTimeout(manualScanPersistTimer); manualScanObserver?.disconnect();
      await ui.message({ type: 'CLEAR_CATCHER_RESEARCH_COMMAND' });
      catcherCommand = null; manualScanObserver = null;
      ui.status(root, 'Đã hủy lượt quét. Không gửi advertiser nào về Hi Auto.');
    });
    scan();
  };
  const runAutomatic = async () => {
    advertiserCommand = (await ui.message({ type: 'GET_ADVERTISER_COMMAND' })).command;
    if (!advertiserCommand?.automatic) return;
    await refreshContext();
    if (advertiserCommand.session_id !== context.id || advertiserCommand.source_catcher_id !== context.selected_source_domain_id) {
      throw new Error('Automatic advertiser command/session/catcher identity mismatch.');
    }
    const blocked = jobs.detectBlockedPage({ url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 5000) });
    if (blocked) {
      await finishAutomatic('captcha', { error_message: 'Ads Transparency requires a manual CAPTCHA check.' }); return;
    }
    if (jobs.matchesAdsTransparencyDomainFilter(location.href, advertiserCommand.domain)) {
      ui.status(root, `Đang chờ Ads Transparency tải đủ kết quả cho ${advertiserCommand.domain} (tối thiểu 6 giây).`);
      const filtered = await waitForFilteredAdvertisers(Date.now() + 12_000);
      if (filtered.blocked) {
        await finishAutomatic('captcha', { error_message: 'Ads Transparency requires a manual CAPTCHA check.' }); return;
      }
      if (!filtered.candidates.length) {
        await finishAutomatic('no_advertiser_found', {
          evidence: { domain: advertiserCommand.domain, filter_url: location.href },
        });
        return;
      }
      ui.status(root, `Tìm thấy ${filtered.candidates.length} advertiser; đang xử lý lần lượt.`);
      await ui.message({ type: 'SET_ADVERTISER_PROFILE_BATCH', profiles: filtered.candidates });
      return;
    }
    if (/^\/advertiser\/AR\d+(?:\/|$)/.test(location.pathname)) {
      const canonicalProfile = jobs.canonicalAdvertiserProfileUrl(location.href, advertiserCommand.advertiser_id);
      if (advertiserCommand.advertiser_id && canonicalProfile
          && !jobs.validateAdvertiserProfile(location.href, advertiserCommand.advertiser_id)) {
        ui.status(root, 'Đang mở hồ sơ advertiser');
        await ui.message({
          type: 'NAVIGATE_ADVERTISER_PROFILE', job_id: advertiserCommand.job_id,
          advertiser_id: advertiserCommand.advertiser_id, profile_url: canonicalProfile,
          evidence: { source_url: location.href, reason: 'creative_detail_canonicalized_to_advertiser_profile' },
        });
        return;
      }
      if (!advertiserCommand.advertiser_id || !jobs.validateAdvertiserProfile(location.href, advertiserCommand.advertiser_id)) {
        await finishAutomatic('parser_error', { error_message: 'Advertiser profile host/ID does not match the selected search result.' }); return;
      }
      ui.status(root, `Đang lưu advertiser ${advertiserCommand.index}/${advertiserCommand.total} cho ${advertiserCommand.domain}.`);
      try { await saveCurrentProfile(); }
      catch (error) {
        if (error.reviewRequired) {
          const warnings = error.profileWarnings ?? [];
          const onlyMissingLegalName = warnings.length > 0
            && warnings.every((warning) => warning === 'missing_legal_name_review_required');
          await finishAutomatic(onlyMissingLegalName ? 'profile_review_skipped' : 'needs_manual_review', {
            error_code: error.profileWarnings?.[0] ?? 'profile_review_required', error_message: error.message,
            evidence: { profile_url: location.href, warnings, skipped_without_stopping_batch: onlyMissingLegalName },
          });
          ui.status(root, onlyMissingLegalName
            ? 'Bỏ qua profile thiếu tên pháp lý; đang chuyển sang domain tiếp theo.'
            : error.message, !onlyMissingLegalName); return;
        }
        throw error;
      }
      return;
    }
    const existingLinks = advertiserLinks();
    if (existingLinks.length) {
      ui.status(root, 'Đang chờ kết quả advertiser');
      const existingChoice = jobs.chooseAdvertiserCandidate(existingLinks, advertiserCommand.domain);
      if (existingChoice.status === 'advertiser_found') {
        await ui.message({
          type: 'NAVIGATE_ADVERTISER_PROFILE', job_id: advertiserCommand.job_id,
          advertiser_id: existingChoice.candidate.advertiser_id,
          profile_url: existingChoice.candidate.profile_url,
          evidence: existingChoice.candidate.evidence,
        });
        return;
      }
      if (existingChoice.status === 'needs_manual_review') {
        await finishAutomatic('needs_manual_review', {
          error_code: 'ambiguous_advertiser_results',
          error_message: 'Existing Ads Transparency results did not contain one unambiguous exact-domain profile.',
          evidence: { candidates: existingChoice.candidates ?? [] },
        });
        return;
      }
    }
    const input = [...document.querySelectorAll('input[type="search"],input[placeholder*="search" i],input[aria-label*="search" i],input')].find(visible);
    if (!input) {
      await finishAutomatic('parser_error', { error_message: 'Ads Transparency search input was not found.' }); return;
    }
    ui.status(root, 'Đang nhập domain');
    input.focus(); autocomplete.fillSearchInput(input, advertiserCommand.domain);
    ui.status(root, 'Đang chờ đề xuất');
    const suggestion = await autocomplete.waitForExactSuggestion({
      root: document, catcherDomain: advertiserCommand.domain, timeoutMs: 10_000, pollMs: 100,
    });
    if (suggestion.status === 'missing') {
      await manualSuggestionReview(advertiserCommand.domain, suggestion,
        `Không tìm thấy đề xuất chính xác cho ${advertiserCommand.domain}`);
      return;
    }
    if (suggestion.status === 'ambiguous') {
      await manualSuggestionReview(advertiserCommand.domain, suggestion,
        `Có nhiều đề xuất chính xác cho ${advertiserCommand.domain}; cần chọn thủ công.`);
      return;
    }
    ui.status(root, `Đã tìm thấy đề xuất: ${advertiserCommand.domain}`);
    ui.status(root, 'Đang chọn đề xuất');
    const selection = await selectExactSuggestion(input, advertiserCommand.domain, suggestion);
    if (selection.failed) {
      await finishAutomatic('suggestion_click_failed', {
        error_code: 'suggestion_click_failed',
        error_message: `Không thể chọn đề xuất chính xác cho ${advertiserCommand.domain}`,
        evidence: { domain: advertiserCommand.domain, candidates: selection.decision?.candidates ?? suggestion.candidates },
      });
      return;
    }
    if (selection.effect.blocked) {
      await finishAutomatic('captcha', { error_message: 'Ads Transparency requires a manual CAPTCHA check.' }); return;
    }
    ui.status(root, 'Đang chờ Ads Transparency tải và ổn định kết quả advertiser');
    const outcome = await waitForSearchOutcome(Date.now() + ADVERTISER_RESULT_TIMEOUT_MS);
    if (outcome.blocked) {
      await finishAutomatic('captcha', { error_message: 'Ads Transparency requires a manual CAPTCHA check.' }); return;
    }
    if (outcome.timeout) {
      await finishAutomatic('timeout', { error_message: 'Ads Transparency search timed out 15 seconds after selecting the suggestion.' }); return;
    }
    if (outcome.empty) {
      await finishAutomatic('no_advertiser_found', { evidence: { domain: advertiserCommand.domain, result: 'explicit_empty_state' } }); return;
    }
    const choice = jobs.chooseAdvertiserCandidate(outcome.links, advertiserCommand.domain);
    if (choice.status !== 'advertiser_found') {
      await finishAutomatic(choice.status, { error_message: choice.status === 'needs_manual_review' ? 'Search results did not contain one unambiguous exact-domain profile.' : null, evidence: { candidates: choice.candidates ?? [] } }); return;
    }
    await ui.message({
      type: 'NAVIGATE_ADVERTISER_PROFILE', job_id: advertiserCommand.job_id,
      advertiser_id: choice.candidate.advertiser_id, profile_url: choice.candidate.profile_url,
      evidence: choice.candidate.evidence,
    });
  };
  let automaticRunning = false;
  const executeAutomatic = async () => {
    if (automaticRunning) return { ok: true, ignored: true, reason: 'automatic_run_in_progress' };
    automaticRunning = true;
    try { await runAutomatic(); return { ok: true }; } catch (error) {
      if (advertiserCommand?.automatic) {
        await finishAutomatic('parser_error', { error_message: error.message });
        return { ok: false, error: error.message };
      }
      throw error;
    } finally { automaticRunning = false; }
  };
  let catcherResearchRunning = false;
  const executeCatcherResearch = async () => {
    if (catcherResearchRunning) return { ok: true, ignored: true, reason: 'catcher_research_in_progress' };
    catcherResearchRunning = true;
    try { await runCatcherResearch(); return { ok: true }; }
    catch (error) { ui.status(root, error.message, true); return { ok: false, error: error.message }; }
    finally { catcherResearchRunning = false; }
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!['RESUME_AUTOMATIC_ADVERTISER', 'RESUME_CATCHER_RESEARCH'].includes(message?.type)) return undefined;
    const operation = message.type === 'RESUME_CATCHER_RESEARCH'
      ? executeCatcherResearch() : executeAutomatic();
    operation.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  await executeAutomatic();
  await executeCatcherResearch();
  try { if (portfolioCommand) await startManualPortfolioScan(portfolioCommand); }
  catch (error) { ui.status(root, error.message, true); }
})();
