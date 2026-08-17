(async () => {
  await import(chrome.runtime.getURL('content/shared.js'));
  const parsers = await import(chrome.runtime.getURL('lib/parsers.mjs'));
  const jobs = await import(chrome.runtime.getURL('lib/job-orchestrator.mjs'));
  const pacing = await import(chrome.runtime.getURL('lib/serp-pacing.mjs'));
  const ui = globalThis.DiscoveryHelperUi;

  // Manifest bơm script vào mọi Google SERP, nhưng chỉ tab do Ads Discovery sở hữu mới được quét.
  // Affiliate Search là bước chọn link thủ công; Coupon có collector riêng; Google thường phải im lặng.
  // Không đọc được mode cũng dừng (fail closed), tuyệt đối không đoán đây là một job Ads.
  try {
    const context = await ui.message({ type: 'GET_GOOGLE_SERP_MODE' });
    if (context?.mode !== 'ads_discovery') return;
  } catch { return; }

  const root = await ui.mount('Discovery · Google SERP');
  const documentId = crypto.randomUUID();
  const page = Math.floor(Number(new URL(location.href).searchParams.get('start') ?? 0) / 10) + 1;
  let waitingForPersist = false;
  let registeredSerp = false;
  let activeJobId = null;
  const pageStartedAt = Date.now();

  const progress = (job, status, stage, extra = {}) => ui.message({
    type: 'REPORT_DISCOVERY_PROGRESS',
    payload: { job_id: job.job_id, status, stage, current_serp_page: page, document_id: documentId, source: 'serp_content', ...extra },
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForLoad = () => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Google SERP chưa tải xong sau 12 giây.')),
      pacing.SERP_LOAD_TIMEOUT_MS);
    const finish = () => { clearTimeout(deadline); resolve(); };
    if (document.readyState === 'complete') finish();
    else addEventListener('load', finish, { once: true });
  });

  const blockedPage = () => jobs.detectBlockedPage({
    url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 5000),
  });

  const waitForMinimumDwell = async () => {
    const target = pacing.serpPageDwellMs();
    while (Date.now() - pageStartedAt < target) {
      if (blockedPage()) return 'captcha';
      await sleep(Math.min(pacing.SERP_DOM_POLL_MS, target - (Date.now() - pageStartedAt)));
    }
    return null;
  };

  const waitForStableSerp = async (session) => {
    const deadline = Date.now() + pacing.SERP_DOM_TIMEOUT_MS;
    let stability = null;
    let latest = null;
    while (Date.now() < deadline) {
      if (blockedPage()) return { blocked: 'captcha', parsed: null };
      latest = parsers.parseSerpDocument(document, {
        ...session, observed_at: new Date().toISOString(), source_url: location.href,
      });
      stability = pacing.nextSerpStability(stability, latest);
      if (stability.stable) return { blocked: null, parsed: latest };
      await sleep(pacing.SERP_DOM_POLL_MS);
    }
    const evidence = latest?.dropped?.[0]?.evidence || 'Google chưa render một SERP ổn định.';
    throw new Error(`Trang SERP ${page} chưa đọc ổn định sau 15 giây: ${evidence}`);
  };

  try {
    const context = await ui.message({ type: 'GET_DISCOVERY_JOB' });
    const session = context.session; const job = context.job;
    activeJobId = job?.job_id ?? null;
    if (jobs.isPostSerpStage(job)) {
      ui.status(root, 'SERP collection already completed.');
      return;
    }
    root.querySelector('h3').textContent = `Discovery · SERP ${page}/${session.serp_pages}`;
    const identity = jobs.validateJobIdentity(job, { session_id: session.id });
    if (!identity.valid) {
      ui.status(root, `Discovery job cannot scan this page: ${identity.reason}`, true);
      return;
    }
    const registration = await ui.message({
      type: 'REGISTER_SERP_TAB', job_id: job.job_id, document_id: documentId,
      page_number: page, source_url: location.href,
    });
    if (registration?.ignored && registration?.stale) {
      ui.status(root, 'SERP collection already completed.');
      return;
    }
    registeredSerp = Boolean(registration?.registered || registration?.idempotent);
    const validation = parsers.validateGoogleSerpContext(location.href, session, page);
    if (!validation.valid) {
      await progress(job, 'context_mismatch', 'scanning_serp', {
        error_code: 'context_mismatch',
        error_message: validation.mismatches.map((item) => `${item.field} expected=${item.expected} actual=${item.actual}`).join('; '),
      });
      throw new Error('SERP context mismatch; no data was written.');
    }
    await progress(job, 'running', 'scanning_serp');
    await waitForLoad();
    const dwellBlocked = await waitForMinimumDwell();
    const stable = dwellBlocked ? { blocked: dwellBlocked, parsed: null } : await waitForStableSerp(session);
    const blocked = stable.blocked;
    if (blocked) {
      await progress(job, 'captcha', 'scanning_serp', { error_code: 'captcha', error_message: 'Google requires a manual CAPTCHA check.' });
      ui.status(root, 'Google yêu cầu CAPTCHA. Dữ liệu đã thu được trước đó được giữ nguyên.', true);
      return;
    }
    const parsed = stable.parsed;
    if (parsed.status === 'error') {
      await progress(job, 'partial', 'scanning_serp', { error_code: 'dom_unreadable', error_message: parsed.dropped?.[0]?.evidence ?? 'SERP DOM unreadable' });
      ui.status(root, 'Không đọc được DOM quảng cáo; job dừng ở trạng thái một phần.', true);
      return;
    }
    waitingForPersist = true;
    const result = await ui.message({
      type: 'SAVE_SERP_PAGE', page_number: page,
      payload: {
        parsed, source_url: location.href, job_id: job.job_id, document_id: documentId,
        idempotency_key: `${job.job_id}:serp:${page}`,
      },
    });
    if (!result.acked) throw new Error(`SERP page ${page} did not receive a durable server ACK.`);
    waitingForPersist = false;
    ui.status(root, `Trang ${page}/${session.serp_pages}: ${result.created} ads mới, ${result.duplicates} trùng, ${result.dropped} bỏ qua.`);

    const refreshed = await ui.message({ type: 'GET_DISCOVERY_JOB' });
    if (refreshed.job?.stop_requested || refreshed.job?.status === 'stopping') {
      await progress(job, 'stopped', 'stopped');
      ui.status(root, 'Đã dừng an toàn sau batch hiện tại.');
      return;
    }
    const nextPage = jobs.nextSerpPage(page, session.serp_pages, false);
    if (nextPage) {
      const nextUrl = parsers.buildGoogleSerpUrl(location.href, session, nextPage);
      if (!jobs.allowedNavigation(nextUrl, 'serp')) throw new Error('Next SERP navigation was rejected by the allowlist.');
      location.href = nextUrl;
      return;
    }
    waitingForPersist = true;
    await progress(job, 'running', 'waiting_for_persist');
    const finalized = await ui.message({ type: 'FINALIZE_SERP', job_id: job.job_id });
    if (!finalized.aggregation?.acked) throw new Error('Domain aggregation did not receive a durable server ACK.');
    waitingForPersist = false;
    ui.status(root, `Đã lưu ${finalized.aggregation.persisted_ads_count} quảng cáo và ${finalized.aggregation.catcher_count} domain; đang tìm advertiser tuần tự.`);
  } catch (error) {
    try {
      const context = await ui.message({ type: 'GET_DISCOVERY_JOB' });
      if (registeredSerp && context.job?.job_id === activeJobId && jobs.isSerpCollectionStage(context.job)
          && context.job.status !== 'stopping') {
        const status = waitingForPersist ? 'paused' : /timed out|timeout|sau \d+ giây/i.test(error.message) ? 'timeout' : 'disconnected';
        const stage = waitingForPersist ? 'waiting_for_persist' : context.job.stage;
        await progress(context.job, status, stage, { error_code: waitingForPersist ? 'persist_failed' : status, error_message: error.message });
      }
    } catch { /* Preserve the original actionable error. */ }
    ui.status(root, error.message, true);
  }
})();
