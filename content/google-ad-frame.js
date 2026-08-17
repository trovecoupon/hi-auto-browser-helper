(async () => {
  if (window.top === window || !/^https:\/\/www\.google\.com\//i.test(location.href)) return;
  const mode = await chrome.runtime.sendMessage({ type: 'GET_GOOGLE_SERP_MODE' }).catch(() => null);
  if (mode?.mode !== 'ads_discovery') return;
  const coordinator = await import(chrome.runtime.getURL('lib/frame-coordinator.mjs'));
  const documentIdentity = coordinator.createDocumentIdentity();
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const destinationUrl = () => {
    const infrastructure = /(^|\.)(?:google\.com|googleadservices\.com|doubleclick\.net|gstatic\.com)$/i;
    const unwrap = (value, depth = 0) => {
      if (!value || depth > 2) return null;
      try {
        const parsed = new URL(value, location.href);
        for (const key of ['adurl', 'url', 'q', 'dest', 'destination', 'redirect']) {
          const nested = parsed.searchParams.get(key);
          const found = nested ? unwrap(nested, depth + 1) : null;
          if (found) return found;
        }
        return parsed.protocol === 'https:' && !infrastructure.test(parsed.hostname) ? parsed.toString() : null;
      } catch { return null; }
    };
    const values = [...document.querySelectorAll('a[href],[data-destination-url],[data-url]')]
      .flatMap((node) => [node.getAttribute('href'), node.getAttribute('data-destination-url'), node.getAttribute('data-url')]);
    return values.map((value) => unwrap(value)).find(Boolean) ?? null;
  };
  const imageUrls = () => {
    const candidates = [];
    const add = (value, node, score = 0) => {
      if (!value) return;
      try {
        const url = new URL(value, location.href);
        if (url.protocol !== 'https:') return;
        const rect = node?.getBoundingClientRect?.();
        candidates.push({ url: url.toString(), score: score + Math.max(0, (rect?.width || 0) * (rect?.height || 0)) });
      } catch {}
    };
    for (const node of document.querySelectorAll('img,source,video,[style*="background-image"]')) {
      add(node.currentSrc, node, 3_000_000);
      add(node.src, node, 2_000_000);
      add(node.poster, node, 2_000_000);
      for (const attribute of ['data-src', 'data-original', 'data-lazy-src']) add(node.getAttribute?.(attribute), node, 1_000_000);
      const srcset = node.srcset || node.getAttribute?.('srcset');
      if (srcset) for (const part of srcset.split(',')) add(part.trim().split(/\s+/)[0], node, 2_500_000);
      const background = getComputedStyle(node).backgroundImage;
      for (const match of String(background || '').matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(match[1], node, 1_500_000);
    }
    for (const entry of performance.getEntriesByType?.('resource') ?? []) {
      if (entry.initiatorType === 'img' || /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(entry.name)) add(entry.name, null, 100);
    }
    const seen = new Set();
    return candidates.sort((left, right) => right.score - left.score).map((item) => item.url)
      .filter((url) => !seen.has(url) && seen.add(url)).slice(0, 8);
  };
  const readSnapshot = () => {
    const text = clean(document.body?.innerText ?? document.body?.textContent);
    const headline = clean(document.querySelector('h1,h2,h3,[role="heading"]')?.textContent) || null;
    const description = clean(document.querySelector('[aria-label*="description" i],p')?.textContent) || null;
    const display = clean(document.querySelector('cite,[aria-label*="display" i]')?.textContent) || null;
    const parts = display ? display.split(/\s*[›>]\s*/) : [];
    const originalImageUrls = imageUrls();
    return { frame_url: location.href, document_identity: documentIdentity, ready_state: document.readyState,
      creative_text: text || null, headline, description, display_url: parts[0] || null,
      display_path: parts.slice(1).join('/') || null, landing_url: destinationUrl(),
      image_count: document.querySelectorAll('img,svg,canvas,video').length, image_urls: originalImageUrls,
      evidence: text.slice(0, 1200) };
  };
  let wake = null;
  const observer = new MutationObserver(() => { wake?.(); wake = null; });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  const waitForSignal = (milliseconds) => new Promise((resolve) => {
    let settled = false; const finish = () => { if (settled) return; settled = true; clearTimeout(timer); if (wake === finish) wake = null; resolve(); };
    const timer = setTimeout(finish, milliseconds); wake = finish;
  });
  try {
    await coordinator.observeFrameSnapshots({ read_snapshot: readSnapshot, wait_for_signal: waitForSignal, timeout_ms: 7000, poll_ms: 250, stable_rounds: 5, max_messages: 5, send_snapshot: (snapshot) => chrome.runtime.sendMessage({ type: 'ADS_FRAME_SNAPSHOT', snapshot }) });
  } finally { observer.disconnect(); }
})().catch((error) => {
  // Reload/update extension invalidates old child-frame worlds. This is an expected lifecycle event, not a fault.
  if (!/extension context invalidated/i.test(String(error?.message || error))) {
    console.debug('Hi Auto ad-frame observer stopped:', error?.message || error);
  }
});
