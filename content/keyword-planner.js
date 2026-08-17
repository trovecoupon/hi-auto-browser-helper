(() => {
if (globalThis.__HI_AUTO_KEYWORD_PLANNER_CONTENT__) return;
globalThis.__HI_AUTO_KEYWORD_PLANNER_CONTENT__ = true;

let running = false;
const send = (message) => new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
  if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
  if (response?.ok === false) return reject(new Error(response.error || 'Browser Helper rejected the action.'));
  resolve(response);
}));

const waitFor = async (probe, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
};

async function run() {
  if (running) return;
  running = true;
  try {
    const { assignCsv, findAction, findCsvDownload, findFileInput, findForecastEntry, pageState } = await import(
      chrome.runtime.getURL('lib/keyword-planner.mjs')
    );
    const response = await send({ type: 'GET_KEYWORD_PLANNER_COMMAND' });
    const command = response?.command;
    if (!command?.job_id) return;
    const state = pageState();
    if (state === 'needs_login' || state === 'needs_user') {
      await send({ type: 'KEYWORD_PLANNER_PROGRESS', job_id: command.job_id, status: state,
        stage: state, error_code: state === 'needs_login' ? 'LOGIN_REQUIRED' : 'CAPTCHA_REQUIRED' });
      return;
    }
    let input = await waitFor(() => findFileInput(), 4000);
    if (!input) {
      const forecastEntry = findForecastEntry();
      if (forecastEntry) {
        await send({ type: 'KEYWORD_PLANNER_PROGRESS', job_id: command.job_id, status: 'running',
          stage: 'opening_forecast_upload' });
        forecastEntry.click();
        input = await waitFor(() => findFileInput(), 25000);
      } else {
        input = await waitFor(() => findFileInput(), 21000);
      }
    }
    if (!input) {
      await send({ type: 'KEYWORD_PLANNER_PROGRESS', job_id: command.job_id, status: 'needs_user',
        stage: 'upload_input_missing', error_code: 'ELEMENT_NOT_FOUND',
        error_message: 'Bấm ô bên phải “Nhận thông tin dự đoán và lượng tìm kiếm”. Khi màn tải CSV hiện ra, bấm nút chạy tiếp trong Helper.' });
      return;
    }
    if (!assignCsv(input, { name: command.input_name, base64: command.input_base64,
      mime: command.input_mime })) throw new Error('Chrome did not accept the generated CSV file.');
    await send({ type: 'KEYWORD_PLANNER_PROGRESS', job_id: command.job_id, status: 'running',
      stage: 'csv_uploaded' });
    const submit = await waitFor(() => findAction(document, 'result'), 12000);
    if (!submit) {
      await send({ type: 'KEYWORD_PLANNER_PROGRESS', job_id: command.job_id, status: 'needs_user',
        stage: 'ready_for_manual_continue', error_code: 'ELEMENT_NOT_FOUND',
        error_message: 'CSV đã được gắn. Hãy bấm nút xem kết quả trên Keyword Planner.' });
      return;
    }
    submit.click();
    await send({ type: 'KEYWORD_PLANNER_PROGRESS', job_id: command.job_id, status: 'running',
      stage: 'waiting_results' });
    const download = await waitFor(() => findAction(document, 'download'), 90000);
    if (!download) {
      await send({ type: 'KEYWORD_PLANNER_PROGRESS', job_id: command.job_id, status: 'needs_user',
        stage: 'ready_for_manual_download', error_code: 'ELEMENT_NOT_FOUND',
        error_message: 'Đã chờ kết quả nhưng chưa nhận diện được nút tải xuống. Hãy tải CSV thủ công; Helper vẫn theo dõi file.' });
      return;
    }
    download.click();
    const csvChoice = await waitFor(() => findCsvDownload(), 6000);
    if (csvChoice) csvChoice.click();
    await send({ type: 'KEYWORD_PLANNER_PROGRESS', job_id: command.job_id, status: 'running',
      stage: 'waiting_download' });
  } catch (error) {
    await send({ type: 'KEYWORD_PLANNER_CONTENT_ERROR', error_message: String(error?.message || error).slice(0, 400) }).catch(() => {});
  } finally {
    running = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'RESUME_KEYWORD_PLANNER') return false;
  run().then(() => sendResponse({ ok: true }));
  return true;
});

setTimeout(run, 700);
})();
