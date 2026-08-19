/**
 * Side Panel — trung tâm điều khiển Browser Helper 2.0.
 *
 * Chỉ hiển thị + gửi lệnh; mọi trạng thái bền vững do Hi Auto giữ, mọi thao tác trình duyệt do service
 * worker làm. Nhật ký đã lọc dữ liệu nhạy cảm (không bao giờ in token/cookie).
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const selected = new Set();
const selectedProjects = new Set();
let lastJobId = null;
let recentJob = null;
let pendingPermissionOrigins = [];
const selectedSensitive = new Set();
let harvesterState = { coupons: [], review: [], rules: [], settings: {}, active: [] };
let currentHarvesterTab = null;
let couponProjectTotal = null;
let couponProjectsLoading = null;
let refreshBusy = false;
let lastAffiliateJobId = null;
let currentAffiliateSearch = null;
let currentDomainVerification = null;
let currentAffiliatePlan = null;
let harvesterLoading = null;

/** Không bao giờ để token/khoá lọt vào nhật ký hiển thị. */
const SENSITIVE = /(token|authorization|cookie|password|secret|bearer|x-ads-discovery-token)/gi;
function scrub(value) {
  return String(value ?? '')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[đã ẩn]')
    .replace(SENSITIVE, (m) => `${m}=[đã ẩn]`)
    .slice(0, 300);
}

function log(message, kind = 'info') {
  const list = $('[data-log]');
  const item = document.createElement('li');
  item.dataset.kind = kind;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  item.append(time, document.createTextNode(scrub(message)));
  list.prepend(item);
  while (list.children.length > 80) list.lastChild.remove();
}

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!response) return reject(new Error('Service worker không phản hồi. Tải lại extension.'));
    if (response.ok === false) return reject(new Error(response.error ?? 'Thao tác bị từ chối.'));
    resolve(response);
  }));
}

const CONNECTION_LABEL = {
  connected: 'đã kết nối Hi Auto', disconnected: 'chưa kết nối', expired: 'token hết hạn',
};
const AGENT_CONNECTION_LABEL = {
  connected: 'đã ghép', unpaired: 'chưa ghép', expired: 'phiên hết hạn', offline: 'Agent chưa chạy',
};
const STATUS_LABEL = {
  queued: 'chờ trong hàng', ready: 'sẵn sàng', running: 'đang chạy', needs_login: 'cần đăng nhập',
  needs_user: 'cần bạn xử lý', paused: 'đã tạm dừng', saving: 'đang lưu', completed: 'xong',
  failed: 'lỗi', cancelled: 'đã hủy', captcha: 'vướng CAPTCHA', partial: 'một phần',
  context_mismatch: 'sai ngữ cảnh', timeout: 'quá thời gian', disconnected: 'mất kết nối', stopped: 'đã dừng',
};
const RESULT_LABEL = {
  candidates_found: 'đã tìm được mã', no_results: 'không thấy mã nào', needs_review: 'cần xem lại',
  needs_captcha: 'vướng CAPTCHA', google_blocked: 'Google chặn', source_blocked: 'nguồn chặn',
  wrong_merchant: 'sai thương hiệu', completed: 'hoàn tất', failed: 'thất bại',
};

function renderHandshake(shake) {
  $('[data-ext-version]').textContent = shake.extensionVersion;
  $('[data-proto-version]').textContent = shake.protocolVersion;
  const conn = $('[data-conn]');
  conn.textContent = CONNECTION_LABEL[shake.connectionState] ?? shake.connectionState;
  conn.dataset.state = shake.connectionState;
  $('[data-act="repair-connection"]').hidden = shake.connectionState === 'connected';
  const adapters = shake.adapters.map((a) => `${a.name}${a.healthy === false ? ' (lỗi)' : ''}`).join(' · ');
  $('[data-adapters]').textContent = `Adapter: ${adapters || '—'}`;
}

function renderAgentConnection(agent = {}) {
  const state = String(agent.state || 'unpaired');
  const box = $('[data-agent-pairing]');
  box.dataset.state = state;
  $('[data-agent-state]').textContent = AGENT_CONNECTION_LABEL[state] || state;
  $('[data-act="pair-agent"]').hidden = state === 'connected';
  $('[data-agent-code]').hidden = state === 'connected';
}

function updateSelectionUi() {
  const count = selectedProjects.size;
  const selectedButton = $('[data-act="run-selected"]');
  const nextButton = $('[data-act="run-one"]');
  selectedButton.hidden = count === 0;
  selectedButton.textContent = count === 1 ? 'Chạy dự án đã chọn' : `Chạy ${count} dự án đã chọn`;
  nextButton.hidden = count > 0;
  $('[data-selection-status]').textContent = count
    ? `Đã chọn ${count} dự án.`
    : 'Chưa chọn dự án — tool sẽ chạy dự án ưu tiên tiếp theo.';
}

function renderQueue(queue, projectTotal) {
  $('[data-stat="projects"]').textContent = projectTotal ?? '—';
  $('[data-stat="pending"]').textContent = queue?.pending ?? 0;
  $('[data-stat="active"]').textContent = queue?.active ?? 0;
  $('[data-stat="found"]').textContent = queue?.candidates_discovered ?? 0;
}

function renderProjects(projects) {
  const list = $('[data-projects]');
  list.replaceChildren();
  const validIds = new Set((projects ?? []).map((project) => project.screening_id));
  for (const id of [...selectedProjects]) if (!validIds.has(id)) selectedProjects.delete(id);
  for (const project of projects ?? []) {
    const item = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'row small';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selectedProjects.has(project.screening_id);
    check.addEventListener('change', () => {
      if (check.checked) selectedProjects.add(project.screening_id);
      else selectedProjects.delete(project.screening_id);
      updateSelectionUi();
    });
    const text = document.createElement('span');
    text.textContent = `${project.brand_name} · ${project.provider_domain}`;
    label.append(check, text);
    item.append(label);
    list.append(item);
  }
  $('[data-project-count]').textContent = `${projects?.length ?? 0}/${couponProjectTotal ?? '—'}`;
  $('[data-project-status]').textContent = projects?.length
    ? `Đã tải ${projects.length} dự án đầu tiên.`
    : 'Không có dự án phù hợp.';
  updateSelectionUi();
}

async function loadCouponProjects() {
  if (couponProjectsLoading) return couponProjectsLoading;
  $('[data-project-status]').textContent = 'Đang tải danh sách dự án…';
  couponProjectsLoading = (async () => {
    const result = await send({ type: 'GET_COUPON_PROJECTS' });
    couponProjectTotal = Number(result.project_total) || 0;
    renderProjects(result.projects ?? []);
    $('[data-stat="projects"]').textContent = couponProjectTotal;
    return { message: `Đã tải ${result.projects?.length ?? 0}/${couponProjectTotal} dự án.` };
  })();
  try { return await couponProjectsLoading; }
  catch (error) {
    $('[data-project-status]').textContent = `Không tải được: ${scrub(error.message)}`;
    throw error;
  } finally { couponProjectsLoading = null; }
}

function renderAlert(job) {
  const block = $('[data-block="alert"]');
  const needsHuman = job && ['needs_user', 'needs_login'].includes(job.status);
  block.hidden = !needsHuman;
  pendingPermissionOrigins = [];
  const resumeButton = $('[data-act="resume-after-human"]');
  const skipSourceButton = $('[data-act="skip-source"]');
  resumeButton.textContent = 'Tôi đã xử lý xong, chạy tiếp';
  const heldSource = job?.checkpoint?.pending_sources?.[0] ?? null;
  skipSourceButton.hidden = !needsHuman || !heldSource?.url;
  if (!needsHuman) return;
  const errorCode = job.error_code || job.checkpoint?.last_error?.code;
  if (errorCode === 'PERMISSION_MISSING') {
    pendingPermissionOrigins = [...new Set((job.checkpoint?.pending_sources ?? []).flatMap((source) => {
      try { return [`${new URL(source.url).origin}/*`]; } catch { return []; }
    }))];
    const hosts = pendingPermissionOrigins.flatMap((origin) => {
      try { return [new URL(origin.replace(/\*$/, '')).hostname]; } catch { return []; }
    });
    resumeButton.textContent = 'Cấp quyền và tự lấy mã';
    $('[data-alert-text]').textContent = hosts.length
      ? `Chrome cần quyền đọc ${hosts.join(', ')}. Bấm nút bên dưới một lần; Helper sẽ tự quét trang và lấy mã, bạn không cần chọn kết quả hay chép mã.`
      : 'Chrome cần quyền đọc website nguồn. Bấm nút bên dưới để cấp quyền và cho Helper tự lấy mã.';
    return;
  }
  if (errorCode === 'USER_ACTION_REQUIRED') {
    resumeButton.textContent = 'Quét lại ngay';
    $('[data-alert-text]').textContent = 'Trang nguồn có nút Show/Reveal/Copy code. Bạn hãy tự bấm nút đó; Coupon Harvester sẽ tự bắt mã và job tự chạy tiếp. Nếu mã đã hiện nhưng chưa chạy, bấm “Quét lại ngay”.';
    return;
  }
  const text = job.status === 'needs_login'
    ? `Trang ${job.checkpoint?.last_error?.stage ?? 'nguồn'} yêu cầu đăng nhập. Hãy tự đăng nhập ở tab đang mở rồi bấm nút bên dưới.`
    : errorCode === 'CAPTCHA_REQUIRED' || job.result_status === 'needs_captcha'
      ? heldSource?.source_domain
        ? `${heldSource.source_domain} đang hỏi CAPTCHA/Cloudflare. Hãy xử lý rồi bấm “Tôi đã xử lý xong”. Nếu website chặn thật, bấm “Bỏ nguồn này, tìm nguồn khác” — dự án vẫn tiếp tục.`
        : 'Google đang hỏi CAPTCHA. Hãy tự giải trên tab đang mở — công cụ không tự vượt — rồi bấm nút bên dưới.'
      : 'Job đang chờ bạn xử lý một bước thủ công.';
  $('[data-alert-text]').textContent = text;
}

function renderJob(job) {
  const block = $('[data-block="job"]');
  block.hidden = !job;
  if (!job) return;
  $('[data-job="merchant"]').textContent = job.brand_name;
  $('[data-job="domain"]').textContent = job.provider_domain;
  $('[data-job="market"]').textContent = `${job.country} · ${job.language}`;
  const status = $('[data-job="status"]');
  status.textContent = STATUS_LABEL[job.status] ?? job.status;
  status.dataset.state = job.status;
  const budget = job.query_budget || 1;
  const ratio = Math.min(1, (job.queries_run || 0) / budget);
  $('[data-job="bar"]').style.width = `${Math.round(ratio * 100)}%`;
  $('[data-job="queries"]').textContent = `${job.queries_run || 0}/${budget}`;
  $('[data-job="sources"]').textContent = `${job.sources_opened || 0}/${job.source_budget || 0}`;
  $('[data-job="found"]').textContent = `${job.candidate_count || 0}/10`;
  const currentSource = job.checkpoint?.pending_sources?.[0];
  const skipCurrentSource = $('[data-act="skip-current-source"]');
  skipCurrentSource.hidden = !currentSource?.url || !['running', 'needs_user', 'needs_login'].includes(job.status);
  skipCurrentSource.title = currentSource?.source_domain
    ? `Bỏ ${currentSource.source_domain}; giữ dự án và toàn bộ mã đã tìm được` : '';
  const query = job.checkpoint?.queries?.[Math.max(0, (job.checkpoint.query_index ?? 1) - 1)];
  const stage = String(job.stage ?? '');
  const batchTotal = job.checkpoint?.batch_source_total || 0;
  const batchDone = job.checkpoint?.batch_source_done || 0;
  const stageLabel = stage.startsWith('search:') ? `Google ${job.queries_run || 1}/${job.query_budget}: ${job.checkpoint?.current_query || query || ''}`
    : stage.startsWith('read:') ? `Nguồn ${Math.min(batchDone + 1, batchTotal || 5)}/${batchTotal || 5}: ${stage.slice(5)} · đã có ${job.candidate_count || 0}/10 mã`
      : stage === 'claimed' ? 'Đã nhận job, đang chuẩn bị Google'
        : stage === 'user_paused' ? 'Đang tạm dừng tại checkpoint gần nhất' : stage;
  $('[data-job="step"]').textContent = job.result_status
    ? `Kết quả: ${RESULT_LABEL[job.result_status] ?? job.result_status}`
    : (stageLabel || '—');
}

function confidenceLevel(value) {
  if (value >= 0.7) return 'high';
  return value >= 0.5 ? 'mid' : 'low';
}

function renderCandidates(candidates) {
  const block = $('[data-block="candidates"]');
  const list = $('[data-candidates]');
  const actionable = (candidates ?? []).filter((candidate) => candidate.status === 'discovered');
  block.hidden = !actionable.length;
  list.replaceChildren();
  for (const candidate of actionable) {
    const item = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    const canSync = true;
    check.disabled = false;
    check.checked = selected.has(candidate.candidate_id) || canSync;
    if (check.checked) selected.add(candidate.candidate_id);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(candidate.candidate_id); else selected.delete(candidate.candidate_id);
    });
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = candidate.code;
    const conf = document.createElement('span');
    conf.className = 'conf';
    conf.dataset.level = confidenceLevel(candidate.confidence);
    conf.textContent = `tin cậy ${Math.round(candidate.confidence * 100)}%`;
    head.append(check, code, conf);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const syncState = candidate.status === 'accepted' ? 'Đã lưu vào dự án Hi Auto'
      : candidate.status === 'rejected' ? 'Đã bỏ' : 'Chờ đồng bộ';
    meta.textContent = [candidate.project_brand_name ? `${candidate.project_brand_name} · ${candidate.project_domain}` : null,
      syncState,
      candidate.offer_text, candidate.expiry ? `hết hạn ${candidate.expiry}` : null,
      `cách lấy: ${candidate.evidence?.method ?? '—'}`].filter(Boolean).join(' · ');

    const source = document.createElement('div');
    source.className = 'meta';
    const link = document.createElement('a');
    link.href = candidate.source_url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = candidate.source_domain;
    source.append(document.createTextNode(`${candidate.sources?.length ?? 1} nguồn · `), link);

    item.append(head, meta, source);
    list.append(item);
  }
}

function renderHarvester(state, currentTab) {
  harvesterState = state ?? harvesterState;
  currentHarvesterTab = currentTab ?? currentHarvesterTab;
  const active = harvesterState.active?.some((session) => session.tabId === currentHarvesterTab?.id);
  const status = $('[data-harvester="status"]');
  status.textContent = active ? 'đang bắt mã' : 'chưa bật';
  status.dataset.state = active ? 'running' : 'paused';
  $('[data-harvester="count"]').textContent = harvesterState.coupons?.length ?? 0;
  $('[data-harvester="review-count"]').textContent = harvesterState.review?.length ?? 0;
  $('[data-harvester="rule-count"]').textContent = harvesterState.rules?.length ?? 0;
  for (const checkbox of $$('[data-layer]')) checkbox.checked = harvesterState.settings?.[checkbox.dataset.layer] !== false;

  const list = $('[data-harvester-list]'); list.replaceChildren();
  for (const coupon of (harvesterState.coupons ?? []).slice(0, 30)) {
    const item = document.createElement('li');
    const head = document.createElement('div'); head.className = 'row';
    const code = document.createElement('span'); code.className = 'code'; code.textContent = coupon.code;
    const conf = document.createElement('span'); conf.className = 'conf'; conf.dataset.level = coupon.confidence >= 60 ? 'high' : 'mid'; conf.textContent = `${coupon.confidence}%`;
    head.append(code, conf);
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${coupon.hostname} · ${coupon.detectedBy?.join(' + ') || 'text'}${coupon.verified ? ' · đã xác nhận' : ''}`;
    const description = document.createElement('div'); description.className = 'meta'; description.textContent = coupon.offerTitle || coupon.description || '';
    const actions = document.createElement('div'); actions.className = 'row wrap coupon-actions';
    const copy = document.createElement('button'); copy.textContent = 'Copy';
    copy.addEventListener('click', async () => { await navigator.clipboard.writeText(coupon.code); log(`Đã copy ${coupon.code}`, 'ok'); });
    const open = document.createElement('button'); open.textContent = 'Mở nguồn';
    open.addEventListener('click', () => chrome.tabs.create({ url: coupon.sourceUrl }));
    actions.append(copy, open);
    if (!coupon.verified) {
      const verify = document.createElement('button'); verify.textContent = 'Xác nhận';
      verify.addEventListener('click', async () => { await send({ type: 'HARVESTER_VERIFY', id: coupon.id }); await refresh(); });
      actions.append(verify);
    }
    item.append(head, meta, description, actions); list.append(item);
  }

  const rules = $('[data-harvester-rules]'); rules.replaceChildren();
  for (const rule of harvesterState.rules ?? []) {
    const item = document.createElement('li');
    const label = document.createElement('span'); label.textContent = `${rule.hostname} · ${rule.codeSelector}${rule.stale ? ` · lỗi: ${rule.staleReason}` : ''} `;
    const remove = document.createElement('button'); remove.textContent = 'Xóa rule';
    remove.addEventListener('click', async () => { await send({ type: 'HARVESTER_DELETE_RULE', rule_id: rule.id }); await refresh(); });
    item.append(label, remove); rules.append(item);
  }
}

async function activeWebTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:\/\//i.test(tab.url ?? '')) throw new Error('Hãy chuyển sang tab website cần thu coupon.');
  return tab;
}

async function loadHarvesterState() {
  if (harvesterLoading) return harvesterLoading;
  harvesterLoading = (async () => {
    const [result, tabs] = await Promise.all([
      send({ type: 'HARVESTER_GET_STATE', job_id: lastJobId }),
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    ]);
    renderHarvester(result.harvester, tabs[0] ?? null);
    return result;
  })();
  try { return await harvesterLoading; }
  finally { harvesterLoading = null; }
}

async function startHarvesterOnCurrentTab() {
  const tab = await activeWebTab();
  const origin = `${new URL(tab.url).origin}/*`;
  if (!await chrome.permissions.contains({ origins: [origin] })) {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error(`Chưa được cấp quyền đọc ${new URL(tab.url).hostname}.`);
  }
  return send({ type: 'HARVESTER_START', tab_id: tab.id });
}

async function exportHarvester(format) {
  const result = await send({ type: 'HARVESTER_EXPORT', format });
  const blob = new Blob([result.export.text], { type: result.export.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.export.filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { message: `Đã export ${format.toUpperCase()}.` };
}

function renderPanelMode(state) {
  const view = ['overview', 'ads', 'traffic', 'coupon', 'affiliate', 'harvester'].includes(state.helper_view)
    ? state.helper_view : 'overview';
  const couponJob = state.handshake.activeJob ?? null;
  const affiliateJob = state.affiliate_job ?? null;
  const affiliateSearch = state.affiliate_search ?? null;
  const affiliateTask = Boolean(affiliateJob || affiliateSearch);
  const domainVerification = state.domain_verification ?? null;
  const actionableCandidates = (state.candidates ?? []).filter((candidate) => candidate.status === 'discovered');
  const showReview = view === 'coupon' && !couponJob && actionableCandidates.length > 0;
  const showCouponControl = view === 'coupon' && !couponJob && !showReview;

  for (const button of $$('[data-view]')) button.dataset.active = String(button.dataset.view === view);
  $('[data-block="overview"]').hidden = view !== 'overview';
  $('[data-block="ads"]').hidden = view !== 'ads';
  $('[data-block="traffic"]').hidden = view !== 'traffic';
  $('[data-block="coupon-control"]').hidden = !showCouponControl;
  $('[data-block="job"]').hidden = view !== 'coupon' || !couponJob;
  $('[data-block="candidates"]').hidden = !showReview;
  $('[data-block="affiliate"]').hidden = view !== 'affiliate';
  $('[data-aff-idle]').hidden = view !== 'affiliate' || affiliateTask;
  $('[data-block="utilities"]').hidden = view !== 'harvester';
  if (view !== 'coupon' || !couponJob) $('[data-block="alert"]').hidden = true;
  renderAdsTask(state.ads_job, view === 'ads' && !domainVerification);
  renderAdsOcr(state.portfolio_ocr_job, view === 'ads' && !domainVerification);
  renderDomainVerification(domainVerification, view === 'ads');
  if (view === 'ads' && domainVerification) $('[data-ads-idle]').hidden = true;
  renderTraffic(state.traffic, view === 'traffic');
  if (view === 'coupon' && couponProjectTotal === null) {
    loadCouponProjects().catch((error) => log(`Danh sách dự án: ${error.message}`, 'error'));
  }
  if (view === 'harvester') loadHarvesterState().catch((error) => log(`Harvester: ${error.message}`, 'error'));
}

const TRAFFIC_REASON_LABEL = Object.freeze({
  opening_sitedata: 'Đang mở trang chủ SiteData.',
  page_loading: 'Tab SiteData vẫn đang tải trang.',
  waiting_for_manual_paste: 'Domain đã sẵn sàng. Bấm “Dán domain” trên Panel.',
  user_requested_paste: 'Đang dán domain vào ô tìm kiếm SiteData.',
  domain_filled_waiting_for_search: 'Đã dán domain. Bây giờ bạn tự bấm Search trên SiteData.',
  manual_result_detected: 'Đã thấy trang kết quả; Helper đang hút Monthly Visits.',
  waiting_for_search_form: 'Đang chờ ô nhập domain của SiteData xuất hiện.',
  search_input_missing: 'Không tìm thấy ô nhập domain — giao diện SiteData có thể đã thay đổi.',
  search_button_missing: 'Đã điền domain nhưng không tìm thấy nút Search hoặc nút vẫn bị khóa.',
  search_form_timeout: 'Ô tìm kiếm SiteData không sẵn sàng sau 10 giây.',
  user_requested_repaste: 'Đang mở lại trang chủ để dán domain hiện tại.',
  resume_result_page: 'Đã nhận lại tab kết quả đang mở.',
  waiting_for_result_page: 'SiteData chưa chuyển từ trang chủ sang trang kết quả.',
  waiting_for_domain: 'Trang kết quả chưa khớp domain đang kiểm.',
  waiting_for_traffic_data: 'Đã vào trang kết quả nhưng biểu đồ traffic chưa tải xong.',
  auto_filling_domain: 'Auto SiteData đang điền domain vào ô tìm kiếm.',
  auto_search_submitted: 'Đã bấm Search đúng một lần; đang chờ SiteData trả kết quả.',
  auto_search_timeout: 'Sau 45 giây SiteData vẫn chưa chuyển sang trang kết quả. Job được giữ là lỗi kỹ thuật, không ghi thành 0.',
  traffic_tab_reopening: 'Tab SiteData đã bị đóng; Helper đang tự mở lại đúng domain hiện tại.',
  traffic_tab_reopen_failed: 'Đã thử mở lại tab SiteData 3 lần nhưng chưa thành công.',
  sitedata_timeout: 'Sau 30 giây vẫn chưa thấy số traffic hoặc thông báo kết quả rõ ràng. Helper chưa ghi 0/no-data; hãy kiểm tra trang rồi Quét lại hoặc Bỏ.',
  traffic_tab_closed: 'Tab SiteData đã bị đóng.',
  cloudflare: 'SiteData đang yêu cầu xử lý Cloudflare/CAPTCHA thủ công.',
  rate_limited: 'SiteData đang giới hạn tần suất truy cập (rate limit).',
  rate_limited_or_quota: 'SiteData đang giới hạn truy cập hoặc tài khoản đã hết hạn mức.',
  sitedata_pacing_wait: 'Đang nghỉ giữa hai lượt để giữ tốc độ an toàn dưới 100 lần/giờ.',
  sitedata_rate_cooldown: 'SiteData vừa giới hạn tần suất. Helper tự nghỉ 60 phút rồi chạy lại đúng domain này.',
  quota_or_login: 'SiteData yêu cầu đăng nhập hoặc nâng hạn mức.',
  sitedata_server_error: 'Máy chủ SiteData đang báo lỗi 5xx hoặc tạm thời không hoạt động.',
  paused_by_user: 'Hàng kiểm traffic đang tạm dừng.',
  helper_error: 'Helper gặp lỗi khi điều khiển lượt kiểm traffic.',
  user_skipped: 'Bạn đã bỏ qua key này; đang chuẩn bị domain kế tiếp.',
});

const TRAFFIC_ERROR_STATUSES = new Set(['needs_user', 'quota', 'retry', 'no_data']);

function trafficStatusText(status) {
  return STATUS_LABEL[status] || ({
    passed: 'đạt', rejected: 'đã loại', quota: 'hết hạn mức', retry: 'lỗi đọc',
    no_data: 'không có data', cancelled: 'đã bỏ', running: 'đang chờ', queued: 'xếp hàng',
  }[status]) || status || '—';
}

function renderTrafficList(items = []) {
  const target = $('[data-traffic-list]');
  target.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'manual-note';
    empty.textContent = 'Chưa có kết quả traffic.';
    target.append(empty);
    return;
  }
  for (const item of items.slice(0, 25)) {
    const card = document.createElement('div');
    card.className = 'traffic-result';
    const main = document.createElement('div');
    main.className = 'traffic-result-main';
    const domain = document.createElement('div');
    domain.className = 'traffic-result-domain';
    const name = document.createElement('b');
    name.textContent = item.brand_name || item.provider_domain || 'Dự án';
    const host = document.createElement('div');
    host.className = 'muted small';
    host.textContent = `${item.provider_domain || '—'} · ${trafficStatusText(item.status)}`;
    domain.append(name, host);
    const value = document.createElement('span');
    value.className = 'traffic-result-value';
    const visits = Number(item.monthly_visits);
    const hasVisits = item.monthly_visits !== null && item.monthly_visits !== undefined
      && Number.isFinite(visits);
    value.textContent = hasVisits
      ? visits.toLocaleString('vi-VN') : '—';
    main.append(domain, value);
    card.append(main);
    if (TRAFFIC_ERROR_STATUSES.has(item.status) && item.last_error) {
      const error = document.createElement('div');
      error.className = 'traffic-result-error';
      error.textContent = TRAFFIC_REASON_LABEL[item.last_error] || item.last_error;
      card.append(error);
    }
    if (TRAFFIC_ERROR_STATUSES.has(item.status)) {
      const actions = document.createElement('div');
      actions.className = 'traffic-result-actions';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'compact'; retry.textContent = 'Quét lại';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          const result = await send({ type: 'TRAFFIC_ITEM_RETRY', traffic_job_id: item.traffic_job_id });
          trafficFeedback(result.message, 'ok'); await refresh();
        } catch (error) { trafficFeedback(`Không thể quét lại: ${error.message}`, 'error'); }
        finally { retry.disabled = false; }
      });
      const skip = document.createElement('button');
      skip.type = 'button'; skip.className = 'compact danger'; skip.textContent = 'Bỏ';
      skip.addEventListener('click', async () => {
        skip.disabled = true;
        try {
          const result = await send({ type: 'TRAFFIC_ITEM_SKIP', traffic_job_id: item.traffic_job_id });
          trafficFeedback(result.message, 'ok'); await refresh();
        } catch (error) { trafficFeedback(`Không thể bỏ: ${error.message}`, 'error'); }
        finally { skip.disabled = false; }
      });
      actions.append(retry, skip);
      card.append(actions);
    }
    target.append(card);
  }
}

function renderTraffic(traffic, visible) {
  if (!visible) return;
  const data = traffic || {};
  const cooldownRemaining = Math.max(0, Number(data.cooldown_until || 0) - Date.now());
  $('[data-traffic="queued"]').textContent = data.queued || 0;
  $('[data-traffic="running"]').textContent = data.running || 0;
  $('[data-traffic="passed"]').textContent = data.passed || 0;
  $('[data-traffic="rejected"]').textContent = data.rejected || 0;
  renderTrafficList(data.items || []);
  const lastBox = $('[data-traffic-last]');
  const last = data.last_result;
  const lastVisits = Number(last?.monthly_visits);
  if (last?.provider_domain && ['passed', 'rejected', 'no_data', 'cancelled'].includes(last.status)) {
    lastBox.textContent = last.reason === 'user_skipped' || last.last_error === 'user_skipped'
      ? `Đã bỏ · ${last.provider_domain}.`
      : last.status === 'passed'
      ? `OK · ${last.provider_domain}: ${lastVisits.toLocaleString('vi-VN')} visit/tháng · đã chuyển sang Trends.`
      : last.status === 'rejected'
        ? `Đã đọc · ${last.provider_domain}: ${lastVisits.toLocaleString('vi-VN')} visit/tháng · ngoài khoảng 50K–3M.`
        : `Không có data · ${last.provider_domain}. Bạn có thể Quét lại hoặc Bỏ trong danh sách.`;
    lastBox.dataset.kind = last.status === 'passed' ? 'ok' : (last.status === 'rejected' ? 'info' : 'error');
    lastBox.hidden = false;
  } else {
    lastBox.textContent = '';
    lastBox.hidden = true;
  }
  const job = data.job;
  $('[data-traffic-job]').hidden = !job;
  $('[data-traffic-idle]').hidden = Boolean(job);
  const held = job && ['needs_user', 'quota', 'retry'].includes(job.status);
  const actionable = Boolean(job && ['queued', 'running', 'needs_user', 'quota', 'retry'].includes(job.status));
  $('[data-traffic-actions]').hidden = !actionable;
  const runButton = $('[data-act="traffic-run"]');
  // A service worker reload can leave the last job marked as running while its in-memory driver is gone.
  // Keep this control clickable so the explicit user action can recover that orphaned lease immediately.
  runButton.hidden = Boolean(actionable || data.driver_running || data.auto_enabled);
  runButton.textContent = data.auto_enabled
    ? 'Auto SiteData đang bật'
    : 'Bật Auto SiteData';
  $('[data-act="traffic-pause"]').hidden = !data.auto_enabled;
  $('[data-act="traffic-resume"]').hidden = Boolean(data.auto_enabled || !data.paused);
  if (!job) return;
  $('[data-traffic="brand"]').textContent = job.brand_name || 'Dự án';
  $('[data-traffic="domain"]').textContent = job.provider_domain || '—';
  const status = $('[data-traffic="status"]');
  status.textContent = trafficStatusText(job.status);
  status.dataset.state = job.status;
  const visits = Number(job.monthly_visits);
  const progress = Number(data.progress?.traffic_job_id) === Number(job.traffic_job_id)
    ? data.progress : null;
  const progressReason = progress?.detail || TRAFFIC_REASON_LABEL[progress?.reason] || null;
  const cooldownText = cooldownRemaining > 0
    ? `SiteData đang nghỉ do rate limit. Tự chạy lại lúc ${new Date(Number(data.cooldown_until)).toLocaleTimeString('vi-VN')}.`
    : null;
  const progressAge = progress?.updated_at
    ? Math.max(0, Math.floor((Date.now() - Date.parse(progress.updated_at)) / 1000)) : 0;
  const stalledProgress = progressReason && progressAge >= 15
    ? `Đã chờ ${progressAge} giây. ${progressReason}`
    : progressReason;
  const feedback = $('[data-traffic-feedback]');
  if (progress?.stage === 'issue' && progressReason) {
    feedback.textContent = `Đã dừng: ${progressReason}`;
    feedback.dataset.kind = 'error';
    feedback.dataset.progressIssue = 'true';
    feedback.hidden = false;
  } else if (feedback.dataset.progressIssue === 'true') {
    feedback.textContent = '';
    feedback.dataset.progressIssue = 'false';
    feedback.hidden = true;
  } else if (progress?.reason === 'waiting_for_manual_paste' && feedback.dataset.kind !== 'error') {
    feedback.textContent = '';
    feedback.hidden = true;
  }
  $('[data-traffic="instruction"]').textContent = cooldownText || (stalledProgress
    ? stalledProgress
    : held
    ? (job.status === 'quota'
      ? 'SiteData yêu cầu đăng nhập/nâng hạn mức. Xử lý xong rồi bấm “Dán domain”.'
      : 'Trang đang hỏi Cloudflare/CAPTCHA hoặc chưa đọc được. Bạn có thể Quét lại hoặc Bỏ trong danh sách live.')
    : Number.isFinite(visits) && visits > 0
      ? `${visits.toLocaleString('vi-VN')} visit/tháng · ${job.status === 'passed' ? 'đã chuyển sang Trends' : 'ngoài khoảng 50K–3M'}`
      : 'Bấm “Dán domain”, sau đó tự bấm Search trên SiteData.');
}

function trafficFeedback(message, kind = 'info') {
  const box = $('[data-traffic-feedback]');
  box.textContent = message;
  box.dataset.kind = kind;
  box.hidden = !message;
}

function renderAdsTask(job, visible) {
  if (!visible) return;
  const active = Boolean(job?.job_id && !['completed', 'failed', 'cancelled', 'stopped'].includes(job.status));
  $('[data-ads-job]').hidden = !active;
  $('[data-ads-idle]').hidden = active;
  if (!active) return;
  $('[data-ads="title"]').textContent = job.query || 'Đang đào đối thủ';
  $('[data-ads="status"]').textContent = STATUS_LABEL[job.status] || job.status || 'đang chạy';
  $('[data-ads="status"]').dataset.state = job.status || 'running';
  const page = Number(job.current_serp_page || 0);
  const pages = Number(job.requested_pages || 5);
  $('[data-ads="stage"]').textContent = job.stage === 'scanning_serp'
    ? `Đang đọc trang ${page || 1}/${pages}`
    : job.stage || 'Đang chuẩn bị tab làm việc';
  const detail = $('[data-ads="detail"]');
  detail.textContent = job.error_message
    ? `Lỗi: ${job.error_message}`
    : job.stage === 'scanning_serp'
      ? 'Chưa phát hiện lỗi · mỗi trang chờ Google render ổn định và lưu ACK trước khi chuyển.'
      : job.stage === 'waiting_for_persist'
        ? 'Đã đọc đủ trang · đang chờ server xác nhận lưu.'
        : 'Helper sẽ dừng tại đúng trang nếu gặp CAPTCHA, timeout hoặc DOM không đọc được.';
  detail.dataset.state = job.error_message ? 'error' : 'ok';
}

function renderDomainVerification(session, visible) {
  currentDomainVerification = session ?? null;
  const block = $('[data-domain-verify]');
  block.hidden = !visible || !session;
  if (!visible || !session) return;
  $('[data-domain-verify="merchant"]').textContent = session.brand_name || 'Dự án';
  $('[data-domain-verify="query"]').textContent = session.search_query
    ? `Google: ${session.search_query}` : 'Google Search';
  const status = $('[data-domain-verify="status"]');
  const labels = {
    searching_google: 'chờ bạn chọn trang', form_selected: 'đã nhận trang', verifying: 'đang lưu domain',
    completed: 'đã xếp traffic', failed: 'cần thử lại', tab_closed: 'tab đã đóng',
  };
  status.textContent = labels[session.stage] || session.stage || 'đang chuẩn bị';
  status.dataset.state = session.stage === 'failed' ? 'failed'
    : session.stage === 'completed' ? 'completed' : 'running';
  const instruction = $('[data-domain-verify="instruction"]');
  instruction.textContent = session.stage === 'completed'
    ? `Đã xác minh ${session.provider_domain || session.current_host}. Dự án đã chuyển vào hàng kiểm traffic; nếu đạt 50K–3M sẽ tự sang Trends.`
    : session.stage === 'failed'
      ? `Đã nhận ${session.current_host || 'trang bạn chọn'} nhưng Hi Auto chưa lưu xong: ${session.error_message || 'không rõ nguyên nhân'}`
      : session.stage === 'verifying'
        ? `Đã nhận ${session.current_host}; đang lưu domain và nối sang hàng traffic.`
        : session.stage === 'tab_closed'
          ? 'Tab Google của nhiệm vụ đã bị đóng. Hãy đóng nhiệm vụ rồi bấm Xác minh domain lại trong Hi Auto.'
          : 'Trên Google, hãy tự bấm website chính thức của thương hiệu. Helper không tự chọn kết quả; sau khi trang mở xong, domain sẽ được nhận và lưu tự động.';
  $('[data-domain-verify="result"]').textContent = session.current_host
    ? `Trang đã chọn: ${session.current_host}` : '';
  $('[data-act="retry-domain-verification"]').hidden = session.stage !== 'failed';
}

function renderAdsOcr(job, visible) {
  const block = $('[data-ads-ocr]');
  if (!visible || !job?.job_id) { block.hidden = true; return; }
  block.hidden = false;
  const counts = job.counts ?? {};
  const labels = {
    queued: 'đang xếp job', downloading: 'đang tải ảnh', downloaded: 'đã tải xong',
    ocr: 'đang OCR local', ready_to_sync: 'chờ đồng bộ', synced: 'đã đồng bộ',
    failed: 'lỗi', cancelled: 'đã hủy',
  };
  $('[data-ads-ocr="status"]').textContent = labels[job.stage] || job.stage || '—';
  $('[data-ads-ocr="status"]').dataset.state = ['failed', 'cancelled'].includes(job.stage)
    ? 'failed' : (job.stage === 'synced' ? 'completed' : 'running');
  $('[data-ads-ocr="download"]').textContent = `${counts.download_done || 0}/${counts.creatives || 0}`;
  $('[data-ads-ocr="assets"]').textContent = counts.downloaded_assets || 0;
  $('[data-ads-ocr="ocr"]').textContent = `${counts.ocr_done || 0}/${counts.downloaded_creatives || 0}`;
  $('[data-ads-ocr="stage"]').textContent = job.stage === 'downloading'
    ? '1/3 · Hi Auto đang tải toàn bộ ảnh gốc về ổ đĩa.'
    : job.stage === 'ocr'
      ? '2/3 · Tesseract đang đọc các file local song song.'
      : job.stage === 'ready_to_sync'
        ? '3/3 · OCR xong; đang đưa kết quả vào dự án Hi Auto.'
        : job.stage === 'synced'
          ? 'Hoàn tất · kết quả đã nằm trong Hi Auto và hàng dự án.'
          : job.stage === 'failed'
            ? 'Job nền đã dừng vì lỗi.'
            : 'Hi Auto đang chuẩn bị pipeline OCR.';
  $('[data-ads-ocr="detail"]').textContent = job.error
    ? `Lỗi: ${job.error}`
    : job.warnings?.length
      ? `Cảnh báo cache (kết quả OCR vẫn được giữ): ${job.warnings.at(-1)}`
      : `Đọc được ${counts.ocr_read || 0} · trống ${counts.ocr_empty || 0} · lỗi ${counts.ocr_failed || 0}.`;
}

function renderAffiliateSearch(search, profiles = [], hasJob = false) {
  currentAffiliateSearch = search ?? null;
  const block = $('[data-aff-search]');
  block.hidden = !search || hasJob;
  if (!search || hasJob) return;
  $('[data-aff-search="merchant"]').textContent = search.brand_name || 'Dự án affiliate';
  $('[data-aff-search="domain"]').textContent = search.current_host || search.provider_domain || 'Google Search';
  const status = $('[data-aff-search="status"]');
  const controls = $('[data-aff-profile-controls]');
  const instruction = $('[data-aff-search="instruction"]');
  const targetReady = search.stage === 'form_selected';
  status.textContent = search.stage === 'tab_closed' ? 'tab đã đóng'
    : targetReady ? 'đã chọn trang' : 'chờ chọn link';
  controls.hidden = !targetReady;
  instruction.textContent = search.stage === 'tab_closed'
    ? 'Tab Google của nhiệm vụ này đã đóng. Hãy kết thúc nhiệm vụ rồi mở lại từ Hi Auto.'
    : targetReady
      ? `Đã nhận trang ${search.current_host}. Chọn hồ sơ rồi bấm “Quét & điền form này”.`
      : 'Trên Google, hãy tự mở đúng trang Affiliate, Partner hoặc Agency application. Panel sẽ tự nhận tab đó; không cần sao chép URL.';
  const select = $('[data-aff-profile]');
  const previous = select.value;
  select.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = String(profile.profile_id);
    option.textContent = `${profile.name} · ${profile.field_count || 0} trường`;
    option.dataset.default = profile.is_default ? 'true' : 'false';
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  else {
    const defaultProfile = [...select.options].find((option) => option.dataset.default === 'true');
    if (defaultProfile) select.value = defaultProfile.value;
  }
  const start = $('[data-act="start-affiliate-form"]');
  start.disabled = !targetReady || !select.value;
  if (targetReady && !profiles.length) instruction.textContent = 'Không tải được hồ sơ từ Hi Auto. Hãy bấm Kết nối lại rồi thử lại.';
}

function affiliateEditControl(item) {
  let control;
  if (item.type === 'date' || item.field_key === 'date_of_birth') {
    control = document.createElement('input'); control.type = 'date';
  } else if (item.options?.length) {
    control = document.createElement('select');
    for (const entry of item.options) {
      const option = document.createElement('option'); option.value = entry.value || entry.label || '';
      option.textContent = entry.label || entry.value || ''; option.disabled = Boolean(entry.disabled);
      control.append(option);
    }
  } else if (item.type === 'textarea' || item.content_assist || Number(item.maxlength) > 180) {
    control = document.createElement('textarea');
  } else {
    control = document.createElement('input'); control.type = 'text';
  }
  const current = String(item.value ?? '');
  if (control instanceof HTMLSelectElement && current
      && ![...control.options].some((option) => option.value === current)) {
    const option = document.createElement('option'); option.value = current; option.textContent = current;
    control.append(option);
  }
  control.value = current;
  if (Number(item.maxlength) > 0) control.maxLength = Number(item.maxlength);
  return control;
}

function renderAffiliate(job, plan, aiSuggestions = []) {
  currentAffiliatePlan = plan || null;
  const block = $('[data-aff-job]'); block.hidden = !job;
  if (!job) return;
  const missingFields = plan?.missing || [];
  const passwordFields = (plan?.blocked || []).filter((item) => item.local_secret_kind === 'password');
  const passwordPrompts = passwordFields.length
    ? [passwordFields.find((item) => !item.password_confirmation) || passwordFields[0]] : [];
  const blockedFields = (plan?.blocked || []).filter((item) => item.local_secret_kind !== 'password');
  const editableFields = [...new Map((plan?.fields || [])
    .filter((item) => item.dom_id && item.field_signature && !item.sensitive)
    .map((item) => [String(item.dom_id), item])).values()];
  const learnableFields = [...missingFields, ...passwordPrompts];
  const needsLearning = missingFields.length + passwordPrompts.filter((item) => !item.has_local_value).length;
  const knownCount = (plan?.fields?.length || 0) + passwordFields.filter((item) => item.has_local_value).length;
  const technicalError = job.status === 'needs_user' && Boolean(job.error_code);
  $('[data-aff="merchant"]').textContent = job.brand_name || 'Dự án affiliate';
  $('[data-aff="status"]').textContent = job.status === 'needs_captcha' ? 'CAPTCHA thủ công'
    : technicalError ? 'cần quét lại'
      : ['review', 'next', 'submit_ready', 'needs_user'].includes(job.status) ? 'sẵn sàng hỗ trợ'
      : (STATUS_LABEL[job.status] || job.status || '—');
  $('[data-aff="url"]').textContent = job.application_host || job.application_url || '—';
  $('[data-aff="mapped"]').textContent = knownCount;
  $('[data-aff="missing"]').textContent = needsLearning;
  $('[data-aff="blocked"]').textContent = blockedFields.length;
  const fillButton = $('[data-act="fill-affiliate"]');
  fillButton.hidden = !knownCount;
  fillButton.disabled = !knownCount;
  fillButton.textContent = knownCount
    ? `Điền lại ${knownCount} trường đã biết`
    : '';
  const instruction = $('[data-aff="instruction"]');
  const popupOrigins = [...new Set(plan?.popup_frame_origins || [])];
  const popupPermission = $('[data-act="grant-affiliate-popup"]');
  popupPermission.hidden = popupOrigins.length === 0;
  popupPermission.textContent = popupOrigins.length
    ? `Cấp quyền và quét popup (${new URL(popupOrigins[0]).hostname})` : '';
  instruction.textContent = popupOrigins.length
    ? 'Form nằm trong iframe của popup. Bấm nút cấp quyền bên dưới một lần; Helper sẽ tự quét và điền trong popup.'
    : technicalError
    ? `Helper chưa đọc được trang: ${job.error_message || 'hãy tải xong form rồi bấm Quét lại.'}`
    : job.status === 'needs_captcha'
    ? 'CAPTCHA là phần bạn tự xử lý và không phải lỗi. Sau khi hoàn tất, Helper sẽ tự quét lại; nếu trang không đổi thì bấm Quét lại.'
    : needsLearning
      ? 'Helper đã quét mọi trường ở bước này. Nhập phần chưa biết bên dưới; nếu đã điền sai, mở “Sửa trường đã điền”.'
      : plan
        ? 'Hãy kiểm tra form. Nếu có giá trị sai, mở “Sửa trường đã điền”, sửa và lưu để cập nhật ngay trên website.'
        : 'Đang đọc form. Bạn vẫn có thể điền thủ công trong lúc chờ.';
  const editDetails = $('[data-aff-edit-fields]');
  const editList = $('[data-aff-editable]'); editList.replaceChildren();
  editDetails.hidden = editableFields.length === 0;
  $('[data-aff-edit-count]').textContent = editableFields.length;
  for (const item of editableFields.slice(0, 60)) {
    const li = document.createElement('li'); li.className = 'answer-card';
    const question = String(item.label || item.field_key || item.dom_id || 'Trường đã điền').trim();
    const title = document.createElement('strong'); title.textContent = question; li.append(title);
    const answer = affiliateEditControl(item); li.append(answer);
    const save = document.createElement('button'); save.className = 'primary wide';
    save.textContent = 'Lưu sửa & điền lại'; save.disabled = true;
    const updateButton = () => { save.disabled = !answer.value || answer.value === String(item.value ?? ''); };
    answer.addEventListener('input', updateButton); answer.addEventListener('change', updateButton);
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const result = await send({ type: 'LEARN_AFFILIATE_ANSWER', dom_id: item.dom_id,
          field_signature: item.field_signature, label: question, answer: answer.value,
          field_key: item.field_key || null, scope: 'global' });
        log(result.message, 'ok'); await refresh();
      } catch (error) { log(error.message, 'error'); updateButton(); }
    });
    li.append(save); editList.append(li);
  }
  const list = $('[data-aff-missing]'); list.replaceChildren();
  for (const item of learnableFields.slice(0, 40)) {
    const li = document.createElement('li'); li.className = 'answer-card';
    const question = String(item.label || item.field_key || item.dom_id || 'Câu hỏi mới').trim();
    const title = document.createElement('strong'); title.textContent = question; li.append(title);
    const localSecret = item.local_secret_kind === 'password';
    if (localSecret && item.has_local_value) {
      const status = document.createElement('span'); status.className = 'local-secret-status';
      status.textContent = item.has_custom_password
        ? 'Đang dùng mật khẩu riêng đã lưu cục bộ — có thể đổi'
        : 'Đang dùng mật khẩu tự động — có thể đổi';
      li.append(status);
    }
    let answer;
    if (localSecret) {
      answer = document.createElement('input'); answer.type = 'password'; answer.autocomplete = 'new-password';
      answer.placeholder = 'Nhập mật khẩu mới để thay đổi…';
    } else if (item.type === 'date' || item.field_key === 'date_of_birth') {
      answer = document.createElement('input'); answer.type = 'date';
    } else if (item.options?.length) {
      answer = document.createElement('select');
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Chọn câu trả lời…';
      answer.append(placeholder);
      for (const entry of item.options) {
        const option = document.createElement('option'); option.value = entry.value || entry.label || '';
        option.textContent = entry.label || entry.value || ''; answer.append(option);
      }
    } else if (item.type === 'textarea' || item.content_assist || Number(item.maxlength) > 180) {
      answer = document.createElement('textarea'); answer.placeholder = 'Nhập câu trả lời của hồ sơ này…';
    } else {
      answer = document.createElement('input'); answer.placeholder = 'Nhập câu trả lời…';
    }
    if (Number(item.maxlength) > 0) answer.maxLength = Number(item.maxlength);
    li.append(answer);
    const save = document.createElement('button'); save.className = 'primary wide';
    save.textContent = localSecret ? 'Lưu mật khẩu mới & điền lại' : 'Lưu vào hồ sơ & dùng ngay';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const result = localSecret
          ? await send({ type: 'LEARN_AFFILIATE_LOCAL_SECRET', dom_id: item.dom_id,
            secret_kind: 'password', answer: answer.value })
          : await send({ type: 'LEARN_AFFILIATE_ANSWER', dom_id: item.dom_id,
            field_signature: item.field_signature, label: question, answer: answer.value,
            field_key: item.field_key || null, scope: 'global' });
        if (localSecret) answer.value = '';
        log(result.message, 'ok'); await refresh();
      } catch (error) { log(error.message, 'error'); save.disabled = false; }
    });
    li.append(save);
    if (!localSecret && item.field_signature && plan?.available_fields?.length) {
      const row = document.createElement('div'); row.className = 'saved-answer-row';
      const select = document.createElement('select');
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Hoặc dùng câu trả lời đã lưu…'; select.append(placeholder);
      for (const field of plan.available_fields) { const option = document.createElement('option'); option.value = field.field_key; option.textContent = field.label; select.append(option); }
      const button = document.createElement('button'); button.textContent = 'Dùng'; button.disabled = true;
      select.addEventListener('change', () => { button.disabled = !select.value; });
      button.addEventListener('click', async () => { button.disabled = true; try { const result = await send({ type: 'LEARN_AFFILIATE_MAPPING', field_signature: item.field_signature, field_key: select.value, scope: 'global' }); log(result.message, 'ok'); await refresh(); } catch (error) { log(error.message, 'error'); button.disabled = false; } });
      row.append(select, button); li.append(row);
    }
    list.append(li);
  }
  let confirmable = 0;
  let manualSensitive = 0;
  for (const item of blockedFields.slice(0, 20)) {
    if (item.reason === 'confirmation_required' && item.field_id) {
      const li = document.createElement('li'); li.className = 'answer-card';
      confirmable += 1;
      const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox';
      input.addEventListener('change', () => input.checked ? selectedSensitive.add(item.field_id) : selectedSensitive.delete(item.field_id));
      label.append(input, document.createTextNode(` Xác nhận điền: ${item.field_key || item.dom_id}`)); li.append(label);
      list.append(li);
    } else manualSensitive += 1;
  }
  const manualCount = manualSensitive;
  if (manualCount) {
    const li = document.createElement('li'); li.className = 'manual-note';
    li.textContent = `${manualCount} ô thông thường/nhạy cảm để bạn tự điền. Đây không phải lỗi và không làm dừng Helper.`;
    list.append(li);
  }
  $('[data-act="confirm-sensitive"]').hidden = confirmable === 0;
  const aiList = $('[data-aff-ai]'); aiList.replaceChildren();
  for (const item of aiSuggestions) {
    const li = document.createElement('li');
    li.append(document.createTextNode(`AI: ${item.label || item.dom_id} → ${item.field_key} `));
    const button = document.createElement('button'); button.textContent = 'Chấp nhận';
    button.addEventListener('click', async () => { button.disabled = true; try { const result = await send({ type: 'LEARN_AFFILIATE_MAPPING', field_signature: item.field_signature, field_key: item.field_key, scope: 'domain' }); log(result.message, 'ok'); await refresh(); } catch (error) { log(error.message, 'error'); } finally { button.disabled = false; } });
    li.append(button); aiList.append(li);
  }
}

// Khối "Điền form offline" sống ĐỘC LẬP với tool/Agent — cập nhật cả khi handshake lỗi.
async function refreshOfflineFill() {
  try {
    const state = await send({ type: 'OFFLINE_FILL_STATE' });
    $('[data-offline-count]').textContent = `hồ sơ: ${state.count} mục`;
  } catch { /* Service worker chưa dậy — giữ nhãn cũ. */ }
}

async function refresh() {
  refreshOfflineFill();
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const state = await send({ type: 'GET_HELPER_HANDSHAKE' });
    renderHandshake(state.handshake);
    renderAgentConnection(state.agent_connection);
    renderQueue(state.queue, couponProjectTotal ?? state.project_total);
    renderJob(state.handshake.activeJob);
    renderAlert(state.handshake.activeJob);
    const visibleJobId = state.handshake.activeJob?.job_id ?? state.recent_job?.job_id ?? null;
    if (visibleJobId !== lastJobId) {
      selected.clear();
      lastJobId = visibleJobId;
    }
    const affiliateJobId = state.affiliate_job?.job_id ?? null;
    if (affiliateJobId !== lastAffiliateJobId) {
      selectedSensitive.clear();
      lastAffiliateJobId = affiliateJobId;
    }
    renderCandidates(state.candidates);
    renderAffiliateSearch(state.affiliate_search, state.affiliate_profiles, Boolean(state.affiliate_job));
    renderAffiliate(state.affiliate_job, state.affiliate_plan, state.affiliate_ai_suggestions);
    renderPanelMode(state);
    recentJob = state.recent_job ?? null;
  } catch (error) {
    const conn = $('[data-conn]');
    conn.textContent = 'chưa kết nối';
    conn.dataset.state = 'disconnected';
    log(error.message, 'error');
  } finally { refreshBusy = false; }
}

const ACTIONS = {
  'repair-connection': () => send({ type: 'REPAIR_HI_AUTO_CONNECTION' }),
  'pair-agent': async () => {
    const input = $('[data-agent-code]');
    const feedback = $('[data-agent-feedback]');
    feedback.hidden = false; feedback.dataset.kind = ''; feedback.textContent = 'Đang ghép với Local Agent…';
    try {
      const result = await send({ type: 'PAIR_LOCAL_AGENT', code: input.value });
      input.value = ''; feedback.dataset.kind = 'ok'; feedback.textContent = result.message;
      return result;
    } catch (error) {
      feedback.dataset.kind = 'error'; feedback.textContent = error.message;
      throw error;
    }
  },
  'traffic-run': async () => {
    trafficFeedback('Đang bật Auto SiteData và chuẩn bị domain đầu tiên…');
    try {
      const result = await send({ type: 'TRAFFIC_QUEUE_RUN' });
      trafficFeedback(result.message || 'Đã bật Auto SiteData.', 'ok');
      return result;
    } catch (error) {
      trafficFeedback(`Không thể chạy: ${error.message}`, 'error');
      throw error;
    }
  },
  'traffic-pause': () => send({ type: 'TRAFFIC_QUEUE_PAUSE' }),
  'traffic-resume': () => send({ type: 'TRAFFIC_QUEUE_RESUME' }),
  'traffic-paste': async () => {
    trafficFeedback('Đang mở lại SiteData cho domain hiện tại…');
    try {
      const result = await send({ type: 'TRAFFIC_JOB_REPASTE' });
      trafficFeedback(result.message, 'ok');
      return result;
    } catch (error) {
      trafficFeedback(`Không thể dán: ${error.message}`, 'error');
      throw error;
    }
  },
  'traffic-skip': async () => {
    trafficFeedback('Đang bỏ key hiện tại và chuẩn bị domain kế tiếp…');
    try {
      const result = await send({ type: 'TRAFFIC_JOB_SKIP' });
      trafficFeedback(result.message, 'ok');
      return result;
    } catch (error) {
      trafficFeedback(`Không thể bỏ qua: ${error.message}`, 'error');
      throw error;
    }
  },
  'harvester-start': () => startHarvesterOnCurrentTab(),
  'harvester-picker': async () => {
    const tab = await activeWebTab();
    if (!harvesterState.active?.some((session) => session.tabId === tab.id)) await startHarvesterOnCurrentTab();
    return send({ type: 'HARVESTER_PICKER', tab_id: tab.id });
  },
  'harvester-export-json': () => exportHarvester('json'),
  'harvester-export-csv': () => exportHarvester('csv'),
  'harvester-save-settings': () => send({
    type: 'HARVESTER_UPDATE_SETTINGS',
    settings: Object.fromEntries($$('[data-layer]').map((input) => [input.dataset.layer, input.checked])),
  }),
  'harvester-clear': () => send({ type: 'HARVESTER_CLEAR' }),
  'run-one': () => send({ type: 'COUPON_QUEUE_RUN', count: 1, ...queueSettings() }),
  'run-ten': () => send({ type: 'COUPON_QUEUE_RUN', count: 10, ...queueSettings() }),
  'run-all': () => send({ type: 'COUPON_QUEUE_RUN', all: true, ...queueSettings() }),
  'run-selected': () => {
    if (!selectedProjects.size) throw new Error('Hãy chọn ít nhất một dự án.');
    return send({
      type: 'COUPON_QUEUE_RUN', count: selectedProjects.size,
      screening_ids: [...selectedProjects], ...queueSettings(),
    });
  },
  'refresh-projects': () => loadCouponProjects(),
  pause: () => send({ type: 'COUPON_QUEUE_PAUSE', paused: true }),
  resume: () => send({ type: 'COUPON_QUEUE_PAUSE', paused: false }),
  'pause-job': () => send({ type: 'COUPON_JOB_PAUSE' }),
  deeper: () => send({
    type: 'COUPON_JOB_DEEPER',
    screening_id: recentJob?.screening_id,
    target_count: recentJob?.target_count,
    country: recentJob?.country,
    language: recentJob?.language,
  }),
  cancel: () => send({ type: 'COUPON_JOB_CANCEL' }),
  skip: () => send({ type: 'COUPON_JOB_SKIP' }),
  'skip-source': () => send({ type: 'COUPON_SOURCE_SKIP' }),
  'skip-current-source': () => send({ type: 'COUPON_SOURCE_SKIP' }),
  'resume-after-human': async () => {
    // Xin đúng origin trong cú click người dùng rồi mới yêu cầu service worker mở/quét nguồn.
    if (pendingPermissionOrigins.length) {
      const granted = await chrome.permissions.request({ origins: pendingPermissionOrigins });
      if (!granted) throw new Error('Bạn chưa cấp quyền đọc website nguồn; Helper chưa thể tự lấy mã.');
      const confirmed = await chrome.permissions.contains({ origins: pendingPermissionOrigins });
      if (!confirmed) throw new Error('Chrome chưa lưu quyền website nguồn. Hãy bấm lại và chọn Cho phép.');
    }
    log('Đã cấp quyền; đang quét lại trang và lấy mã…', 'ok');
    return send({ type: 'COUPON_JOB_RESUME' });
  },
  sync: async () => {
    const result = await send({ type: 'COUPON_SYNC_CANDIDATES', candidate_ids: [...selected] });
    selected.clear();
    return result;
  },
  'offline-fill': async () => {
    // Xin quyền origin ngay trong cú click (gesture) rồi mới nhờ service worker bơm scanner.
    const tab = await activeWebTab();
    const origin = `${new URL(tab.url).origin}/*`;
    const granted = await chrome.permissions.contains({ origins: [origin] })
      || await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error(`Bạn chưa cấp quyền đọc ${new URL(tab.url).hostname}.`);
    return send({ type: 'OFFLINE_FILL_START', tab_id: tab.id });
  },
  'offline-clear': () => send({ type: 'OFFLINE_FILL_CLEAR' }),
  'fill-affiliate': () => send({ type: 'APPLY_AFFILIATE_SAFE_FIELDS' }),
  'refresh-affiliate-state': async () => {
    let result = await send({ type: 'REFRESH_AFFILIATE_CURRENT_STATE' });
    if (result.permission_origin) {
      const granted = await chrome.permissions.request({ origins: [result.permission_origin] });
      if (!granted) throw new Error('Bạn chưa cấp quyền đọc tab form Affiliate.');
      result = await send({ type: 'REFRESH_AFFILIATE_CURRENT_STATE' });
    }
    return result;
  },
  'grant-affiliate-popup': async () => {
    const origins = [...new Set(currentAffiliatePlan?.popup_frame_origins || [])];
    if (!origins.length) throw new Error('Không còn iframe popup cần cấp quyền. Hãy bấm Quét lại hiện trạng.');
    const granted = await chrome.permissions.request({ origins });
    if (!granted) throw new Error('Bạn chưa cấp quyền đọc form trong popup.');
    return send({ type: 'GRANT_AFFILIATE_POPUP_ACCESS', origins });
  },
  'start-affiliate-form': async () => {
    if (!currentAffiliateSearch?.current_url || currentAffiliateSearch.stage !== 'form_selected') {
      throw new Error('Hãy chọn trang đăng ký từ Google trước.');
    }
    const profileId = Number($('[data-aff-profile]').value);
    if (!Number.isInteger(profileId) || profileId <= 0) throw new Error('Hãy chọn hồ sơ cần dùng.');
    const target = new URL(currentAffiliateSearch.current_url);
    const origins = [`${target.origin}/*`];
    const granted = await chrome.permissions.contains({ origins })
      || await chrome.permissions.request({ origins });
    if (!granted) throw new Error(`Bạn chưa cấp quyền đọc ${target.hostname}.`);
    return send({ type: 'START_AFFILIATE_FROM_SEARCH', profile_id: profileId });
  },
  'cancel-affiliate-search': () => send({ type: 'CANCEL_AFFILIATE_SEARCH' }),
  'retry-domain-verification': () => send({ type: 'RETRY_DOMAIN_VERIFICATION' }),
  'cancel-domain-verification': () => send({ type: 'CANCEL_AFFILIATE_SEARCH' }),
  'confirm-sensitive': () => send({ type: 'CONFIRM_AFFILIATE_SENSITIVE_FIELDS', field_ids: [...selectedSensitive] }),
  'ai-map-affiliate': () => send({ type: 'SUGGEST_AFFILIATE_AI_MAPPINGS' }),
  'submitted-affiliate': () => send({ type: 'MARK_AFFILIATE_SUBMITTED' }),
  'cancel-affiliate': () => send({ type: 'CANCEL_AFFILIATE_APPLICATION' }),
};

function queueSettings() {
  return {
    search_depth: $('[data-depth]').value,
    country: $('[data-market="country"]').value.trim().toUpperCase(),
    language: $('[data-market="language"]').value.trim().toLowerCase(),
  };
}

for (const button of $$('[data-act]')) {
  button.addEventListener('click', async () => {
    const action = ACTIONS[button.dataset.act];
    if (!action) return;
    button.disabled = true;
    try {
      const result = await action();
      log(result.message ?? `${button.textContent.trim()} — xong`, 'ok');
    } catch (error) {
      log(`${button.textContent.trim()} — ${error.message}`, 'error');
    } finally {
      button.disabled = false;
      refresh();
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'HELPER_STATE_CHANGED') {
    if (message.log) log(message.log, message.kind ?? 'info');
    refresh();
  }
  return false;
});

refresh();
$('[data-project-picker]').addEventListener('toggle', (event) => {
  if (event.currentTarget.open && couponProjectTotal === null) loadCouponProjects().catch(() => {});
});
$('[data-tools-drawer]').addEventListener('toggle', async (event) => {
  if (!event.currentTarget.open) return;
  loadHarvesterState().catch((error) => log(`Harvester: ${error.message}`, 'error'));
});
for (const button of $$('[data-view]')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await send({ type: 'SET_HELPER_VIEW', mode: button.dataset.view }); }
    catch (error) { log(error.message, 'error'); }
    finally { button.disabled = false; refresh(); }
  });
}
setInterval(refresh, 3000);
