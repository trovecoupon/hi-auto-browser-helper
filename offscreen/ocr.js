let workerPromise;
let recognitionQueue = Promise.resolve();

// CC-55 (CC-51-F01): mọi bước Tesseract có hạn giờ. Trước đây một lượt khởi tạo/recognize treo làm
// recognitionQueue không bao giờ settle → mọi OCR sau đó (ảnh gốc lẫn mã coupon) chờ vô hạn. Quá hạn:
// bỏ đúng worker đó (terminate) và trả ok:false cho người gọi; lượt sau tự tạo worker mới.
const OCR_INIT_TIMEOUT_MS = 60_000;      // tải WASM + eng.traineddata từ gói extension
const OCR_STEP_TIMEOUT_MS = 60_000;      // một lượt setParameters hoặc recognize
const OCR_DECODE_TIMEOUT_MS = 20_000;    // giải mã ảnh data URL
const OCR_TERMINATE_WAIT_MS = 5_000;

function withTimeout(promise, ms, step) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`OCR quá hạn ${Math.round(ms / 1000)} s ở bước ${step}`);
      error.code = 'OCR_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function worker() {
  if (!workerPromise) {
    let created;
    try {
      created = Promise.resolve(Tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
        langPath: chrome.runtime.getURL('vendor/tesseract/lang'),
        corePath: chrome.runtime.getURL('vendor/tesseract/core'),
        logger: () => {},
      }));
    } catch (error) { return Promise.reject(error); }
    const current = withTimeout(created, OCR_INIT_TIMEOUT_MS, 'khởi tạo Tesseract').catch((error) => {
      if (workerPromise === current) workerPromise = null;
      created.then((late) => late?.terminate?.()).catch(() => {});   // khởi tạo xong muộn: không để worker mồ côi
      throw error;
    });
    workerPromise = current;
  }
  return workerPromise;
}

// Chỉ bỏ đúng worker đã hỏng/treo (không đụng worker mới của lượt sau); terminate có hạn để không kẹt hàng đợi.
async function resetWorker(stale = workerPromise) {
  if (workerPromise === stale) workerPromise = null;
  if (!stale) return;
  try {
    await withTimeout(Promise.resolve(stale).then((instance) => instance?.terminate?.()),
      OCR_TERMINATE_WAIT_MS, 'terminate');
  } catch {}
}

async function cropImage(dataUrl, rect, dpr = 1) {
  const image = new Image();
  image.src = dataUrl;
  await withTimeout(image.decode(), OCR_DECODE_TIMEOUT_MS, 'giải mã ảnh');
  const x = Math.max(0, Math.round(Number(rect.x) * dpr));
  const y = Math.max(0, Math.round(Number(rect.y) * dpr));
  const width = Math.max(1, Math.min(image.naturalWidth - x, Math.round(Number(rect.width) * dpr)));
  const height = Math.max(1, Math.min(image.naturalHeight - y, Math.round(Number(rect.height) * dpr)));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, x, y, width, height, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/png'), diagnostic: null };
}

async function prepareOriginalImage(dataUrl) {
  const image = new Image(); image.src = dataUrl;
  await withTimeout(image.decode(), OCR_DECODE_TIMEOUT_MS, 'giải mã ảnh');
  const maxPixels = 12_000_000;
  let scale = image.naturalWidth < 1200 ? Math.min(2.5, 1200 / Math.max(1, image.naturalWidth)) : 1;
  if (image.naturalWidth * image.naturalHeight * scale * scale > maxPixels) {
    scale = Math.sqrt(maxPixels / (image.naturalWidth * image.naturalHeight));
  }
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  const colorDataUrl = canvas.toDataURL('image/png');
  const pixels = context.getImageData(0, 0, width, height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const gray = .299 * pixels.data[index] + .587 * pixels.data[index + 1] + .114 * pixels.data[index + 2];
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 128));
    pixels.data[index] = contrasted; pixels.data[index + 1] = contrasted; pixels.data[index + 2] = contrasted;
  }
  context.putImageData(pixels, 0, 0);
  return { dataUrls: [colorDataUrl, canvas.toDataURL('image/png')], diagnostic: {
    source: 'original_asset', original_width: image.naturalWidth,
    original_height: image.naturalHeight, ocr_width: width, ocr_height: height,
  } };
}

function cleanCreativeText(value) {
  return String(value ?? '').replace(/\r/g, '').split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 8000);
}

async function recognizeOriginal(dataUrl) {
  const startedAt = Date.now(); const prepared = await prepareOriginalImage(dataUrl); let lastError = null;
  for (let workerAttempt = 1; workerAttempt <= 2; workerAttempt++) {
    let pending = null;
    try {
      pending = worker(); const instance = await pending; const attempts = [];
      for (const [index, psm] of ['6', '11'].entries()) {
        await withTimeout(instance.setParameters({ tessedit_char_whitelist: '',
          tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' }), OCR_STEP_TIMEOUT_MS, `setParameters psm ${psm}`);
        const result = await withTimeout(instance.recognize(prepared.dataUrls[index]),
          OCR_STEP_TIMEOUT_MS, `recognize psm ${psm}`);
        const text = cleanCreativeText(result.data?.text);
        attempts.push({ psm, confidence: Number(result.data?.confidence) || 0, characters: text.length });
        if (text) return { text, confidence: Number(result.data?.confidence) || 0,
          diagnostic: { ...prepared.diagnostic, attempts, worker_attempt: workerAttempt,
            elapsed_ms: Date.now() - startedAt } };
      }
      return { text: '', confidence: 0, diagnostic: { ...prepared.diagnostic, attempts,
        worker_attempt: workerAttempt, elapsed_ms: Date.now() - startedAt,
        reason: 'Tesseract đã thử PSM 6 và 11 nhưng không nhận ra chữ trong ảnh gốc' } };
    } catch (error) {
      lastError = error; await resetWorker(pending);
    }
  }
  throw new Error(`Tesseract worker lỗi sau 2 lần khởi tạo: ${String(lastError?.message ?? lastError).slice(0, 160)}`);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'HARVESTER_OCR_IMAGE') return false;
  recognitionQueue = recognitionQueue.catch(() => {}).then(async () => {
    const originalCreative = message.ocr_mode === 'creative-original';
    if (originalCreative) {
      const result = await recognizeOriginal(message.dataUrl);
      return { ok: true, ...result, screenshotCrop: null };
    }
    const pending = worker(); const instance = await pending;
    const crop = await cropImage(message.dataUrl, message.rect, message.dpr);
    let result;
    try {
      await withTimeout(instance.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_', tessedit_pageseg_mode: '7',
      }), OCR_STEP_TIMEOUT_MS, 'setParameters mã coupon');
      result = await withTimeout(instance.recognize(crop.dataUrl), OCR_STEP_TIMEOUT_MS, 'recognize mã coupon');
    } catch (error) {
      // CC-55 (DS-0116-F01): nhánh mã coupon trước đây không reset → worker hỏng/treo bị dùng lại mãi.
      await resetWorker(pending);
      throw error;
    }
    const rawText = String(result.data?.text ?? '');
    const text = rawText.replace(/\s+/g, '').slice(0, 80);
    return {
      ok: true,
      text,
      confidence: Number(result.data?.confidence) || 0,
      screenshotCrop: crop.dataUrl,
      diagnostic: { reason: text ? null : 'Tesseract không nhận ra mã trong vùng ảnh' },
    };
  });
  recognitionQueue.then(respond).catch((error) => respond({ ok: false, error: String(error?.message ?? error).slice(0, 200) }));
  return true;
});
