(async () => {
  await import(chrome.runtime.getURL('content/shared.js'));
  const parsers = await import(chrome.runtime.getURL('lib/parsers.mjs'));
  const jobs = await import(chrome.runtime.getURL('lib/job-orchestrator.mjs'));
  const ui = globalThis.DiscoveryHelperUi; const root = await ui.mount('Discovery · Valentin'); const controls = root.querySelector('[data-controls]');
  const fill = document.createElement('button'); fill.textContent = 'Điền session & geocode'; controls.append(fill);
  const documentId = crypto.randomUUID(); let initialContext = null;
  try { initialContext = await ui.message({ type: 'GET_DISCOVERY_SESSION' }); if (initialContext.location_mode === 'country_only') fill.textContent = 'Điền session & tìm kiếm (không geocode)'; } catch { /* Click reports actionable auth errors. */ }

  const nativeSet = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error(`Native value setter unavailable for ${element.id || element.name}`);
    setter.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const readControls = () => ({
    query: document.querySelector('#search-input')?.value ?? '', regions: document.querySelector('#regions')?.value ?? '',
    language_code: document.querySelector('#hl')?.value ?? '', country_code: document.querySelector('#gl')?.value ?? '',
    exact_location: document.querySelector('#place')?.value ?? '', latitude: document.querySelector('#latitude')?.value ?? '',
    longitude: document.querySelector('#longitude')?.value ?? '', uule: document.querySelector('#uule')?.value ?? ''
  });

  fill.addEventListener('click', async () => {
    if (fill.disabled) return; fill.disabled = true; let state = null; let observer = null; let navigating = false; const suppressed = [];
    try {
      const session = await ui.message({ type: 'GET_DISCOVERY_SESSION' });
      const plan = parsers.buildValentinFillPlan(document.documentElement.outerHTML, session);
      if (!plan.ready || (!plan.skip_geocode && !plan.geocode_selector)) throw new Error(plan.error ?? 'Valentin live controls are incomplete');
      for (const assignment of Object.values(plan.assignments)) {
        const input = document.querySelector(assignment.selector); if (!input) throw new Error(`Valentin field disappeared: ${assignment.selector}`);
        input.focus(); nativeSet(input, assignment.value);
      }
      const before = readControls(); const startedAt = new Date().toISOString(); let completionSignal = false;
      if (plan.skip_geocode) {
        for (const selector of ['#latitude','#longitude','#uule']) { const input = document.querySelector(selector); if (input) nativeSet(input, ''); }
        const current = readControls();
        if (current.query !== String(session.query) || current.language_code.toLowerCase() !== String(session.language_code).toLowerCase() || current.country_code.toUpperCase() !== String(session.country_code).toUpperCase()) throw new Error('Country-only Valentin controls do not match the discovery session');
        if (current.exact_location || current.latitude || current.longitude || current.uule) throw new Error('Country-only Valentin launch must keep location, coordinates, and UULE empty');
        state = { state: 'country_only', uule: null, latitude: null, longitude: null, error: null };
        await ui.message({ type: 'SAVE_VALENTIN_STATE', payload: { state, source_url: location.href, started_at: startedAt, parser_version: parsers.PARSER_VERSION, job_id: session.job?.job_id, document_id: documentId } });
        const submit = document.querySelector(plan.submit_selector);
        if (!submit || submit.id !== 'button-search') throw new Error('Valentin live search control #button-search is unavailable');
        for (const selector of ['#place','#latitude','#longitude','#uule']) {
          const input = document.querySelector(selector); if (!input) continue;
          suppressed.push({ input, disabled: input.disabled, name: input.getAttribute('name') });
          input.disabled = true; input.removeAttribute('name');
        }
        navigating = true; submit.click(); ui.status(root, 'Country-only search launched without geocode or UULE.'); return;
      }
      const watched = ['#latitude', '#longitude', '#uule'].map((selector) => document.querySelector(selector)).filter(Boolean);
      observer = new MutationObserver(() => { completionSignal = true; });
      for (const node of watched) observer.observe(node, { attributes: true, childList: true, characterData: true, subtree: true });
      for (const node of watched) node.addEventListener('input', () => { completionSignal = true; }, { once: true });
      document.querySelector(plan.geocode_selector).click(); ui.status(root, 'Geocoding… validating fresh coordinates and UULE.');
      state = await parsers.waitForValentinGeocode({ timeout_ms: 12_000, poll_ms: 150, read_state: () => parsers.parseValentinState(readControls(), { session, before, completion_signal: completionSignal }) });
      await ui.message({ type: 'SAVE_VALENTIN_STATE', payload: { state, source_url: location.href, started_at: startedAt, parser_version: parsers.PARSER_VERSION, job_id: session.job?.job_id, document_id: documentId } });
      if (!parsers.canSubmitValentinState(state)) throw new Error(state.error ?? 'Valentin did not create a validated UULE');
      const submit = document.querySelector(plan.submit_selector);
      if (!submit || submit.id !== 'button-search') throw new Error('Valentin live search control #button-search is unavailable');
      navigating = true; submit.click(); ui.status(root, `Location validated (${state.geocode_evidence}) and UULE saved.`);
    } catch (error) { ui.status(root, error.message, true); } finally {
      if (!navigating) for (const item of suppressed) { item.input.disabled = item.disabled; if (item.name == null) item.input.removeAttribute('name'); else item.input.setAttribute('name', item.name); }
      ui.finalizeUserAction(fill, observer, navigating);
    }
  });
  if (initialContext?.job && jobs.validateJobIdentity(initialContext.job, { session_id: initialContext.id }).valid && ['preparing', 'opening_market'].includes(initialContext.job.stage)) {
    ui.status(root, 'Hi Auto requested this market. Preparing the validated search.');
    setTimeout(() => fill.click(), 0);
  }
})();
