import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium } from 'playwright';
import { scoreHarvesterCandidate } from '../lib/coupon-harvester.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtureRoot = join(here, 'fixtures');
const isolated = readFileSync(join(root, 'content', 'harvester-isolated.js'), 'utf8');
const main = readFileSync(join(root, 'content', 'harvester-main.js'), 'utf8');
let server; let browser; let base;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/api/coupon') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ couponCode: 'API55' })); return; }
    if (request.url === '/form-assistant.mjs') { response.setHeader('content-type', 'text/javascript'); response.end(readFileSync(join(root, 'lib', 'form-assistant.mjs'))); return; }
    if (request.url === '/offscreen/ocr.js') { response.setHeader('content-type', 'text/javascript'); response.end(readFileSync(join(root, 'offscreen', 'ocr.js'))); return; }
    if (request.url?.startsWith('/vendor/tesseract/')) {
      try {
        const path = join(root, request.url.slice(1));
        response.setHeader('content-type', extname(path) === '.wasm' ? 'application/wasm' : extname(path) === '.gz' ? 'application/gzip' : 'text/javascript');
        response.end(readFileSync(path)); return;
      } catch { response.statusCode = 404; response.end('not found'); return; }
    }
    const name = request.url?.startsWith('/revealed') ? 'new-tab-url.html' : request.url?.slice(1).split('?')[0];
    try { const body = readFileSync(join(fixtureRoot, name || 'asphostportal-headings.html')); response.setHeader('content-type', extname(name ?? '') === '.html' ? 'text/html' : 'text/plain'); response.end(body); }
    catch { response.statusCode = 404; response.end('not found'); }
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
}, 30_000);
afterAll(async () => { await browser?.close(); await new Promise((resolve) => server?.close(resolve)); });

async function instrument(name, settings = {}) {
  const page = await browser.newPage();
  await page.goto(`${base}/${name}`);
  await page.evaluate(({ settings }) => {
    window.__captured = [];
    window.chrome = { runtime: { sendMessage(message) { if (message.type === 'HARVESTER_CANDIDATES') window.__captured.push(...message.candidates); return Promise.resolve({}); }, onMessage: { addListener() {} } } };
    globalThis.__HI_AUTO_HARVESTER_NS__ = 'browser-test';
    globalThis.__HI_AUTO_HARVESTER_CONFIG__ = { namespace: 'browser-test', settings: { text:true,clickdiff:true,clipboard:true,network:true,canvas:true,url:true,rules:true,ocr:false,overlay:false,...settings }, rules: [] };
  }, { settings });
  await page.addScriptTag({ content: main });
  await page.addScriptTag({ content: isolated });
  await page.waitForTimeout(300);
  return page;
}

async function codes(page) {
  await page.waitForTimeout(350);
  const candidates = await page.evaluate(() => window.__captured);
  return [...new Set(candidates.filter((candidate) => scoreHarvesterCandidate(candidate).decision !== 'reject').map((candidate) => candidate.rawCode.toUpperCase()))];
}

describe('Coupon Harvester browser fixtures', () => {
  test('visible ASPHostPortal headings', async () => { const page=await instrument('asphostportal-headings.html');expect((await codes(page)).sort()).toEqual(['DBSQL','FREEDOMAIN']);await page.close(); });
  test('modal and blur after trusted clicks', async () => { for(const [file,selector,code] of [['modal-reveal.html','#show','MODAL20'],['blur-reveal.html','#show','BLUR25']]){const page=await instrument(file);await page.click(selector);expect(await codes(page)).toContain(code);await page.close();} });
  test('clipboard-only, network JSON and canvas runtime hooks', async () => { for(const [file,selector,code] of [['clipboard-only.html','#copy','CLIPBOARD30'],['network-json.html','#load','API55'],['canvas-code.html','#draw','CANVAS45']]){const page=await instrument(file);await page.click(selector);expect(await codes(page)).toContain(code);await page.close();} });
  test('open shadow DOM and same-origin iframe', async () => { const page=await instrument('deep-dom.html');expect(await codes(page)).toEqual(expect.arrayContaining(['SHADOW15','SAME20']));await page.close(); });
  test('URL query, readonly input and ten-offer mapping', async () => { const page=await instrument('new-tab-url.html');expect(await codes(page)).toContain('INPUT35');await page.close();const child=await instrument('revealed?coupon=NEWTAB40');expect(await codes(child)).toContain('NEWTAB40');await child.close();const list=await instrument('ten-offers.html');const found=await codes(list);expect(found.filter(code=>code.startsWith('OFFER'))).toHaveLength(10);await list.close(); });
  test('OCR target exists but is disabled until explicit opt-in', async () => { const page=await instrument('ocr-image.html');expect(await codes(page)).not.toContain('IMAGE20');await page.close(); });
  test('bundled Tesseract OCR reads the image without a CDN', async () => { const page=await browser.newPage();await page.goto(`${base}/ocr-image.html`);await page.addScriptTag({url:`${base}/vendor/tesseract/tesseract.min.js`});const text=await page.evaluate(async(base)=>{const image=document.querySelector('img');await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);const png=canvas.toDataURL('image/png');const worker=await Tesseract.createWorker('eng',1,{workerPath:`${base}/vendor/tesseract/worker.min.js`,langPath:`${base}/vendor/tesseract/lang`,corePath:`${base}/vendor/tesseract/core`,logger:()=>{}});await worker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_',tessedit_pageseg_mode:'7'});const result=await worker.recognize(png);await worker.terminate();return result.data.text.replace(/\s+/g,'');},base);expect(text).toContain('IMAGE20');await page.close(); }, 60_000);
  test('bundled Tesseract creative mode reads ordinary brand and domain text', async () => { const page=await browser.newPage();await page.goto(`${base}/empty.html`);await page.addScriptTag({url:`${base}/vendor/tesseract/tesseract.min.js`});const text=await page.evaluate(async(base)=>{const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=260;const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='black';context.font='700 72px Arial';context.fillText('Cloudways',40,95);context.font='52px Arial';context.fillText('cloudways.com',40,190);const worker=await Tesseract.createWorker('eng',1,{workerPath:`${base}/vendor/tesseract/worker.min.js`,langPath:`${base}/vendor/tesseract/lang`,corePath:`${base}/vendor/tesseract/core`,logger:()=>{}});await worker.setParameters({tessedit_char_whitelist:'',tessedit_pageseg_mode:'6',preserve_interword_spaces:'1'});const result=await worker.recognize(canvas.toDataURL('image/png'));await worker.terminate();return result.data.text;},base);expect(text.toLowerCase()).toContain('cloudways.com');await page.close(); }, 60_000);
  test('real offscreen OCR listener reads an original multi-line ad image', async () => { const page=await browser.newPage();await page.goto(`${base}/empty.html`);await page.evaluate((base)=>{window.chrome={runtime:{getURL:(path)=>`${base}/${path}`,onMessage:{addListener(listener){window.__ocrListener=listener;}}}};},base);await page.addScriptTag({url:`${base}/vendor/tesseract/tesseract.min.js`});await page.addScriptTag({url:`${base}/offscreen/ocr.js`});const result=await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=760;canvas.height=520;const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,760,520);context.fillStyle='#202124';context.font='700 30px Arial';context.fillText('Sponsored',30,55);context.font='32px Arial';context.fillText('ShipTheDeal.com',30,115);context.fillStyle='#185abc';context.font='40px Arial';context.fillText('20% Off ZQuiet Coupon',30,210);context.fillStyle='#4b4b4b';context.font='30px Arial';context.fillText('New discounts. Visit zquiet.com today.',30,290);return new Promise((resolve,reject)=>{const keep=window.__ocrListener({type:'HARVESTER_OCR_IMAGE',ocr_mode:'creative-original',dataUrl:canvas.toDataURL('image/png')},{},resolve);if(keep!==true)reject(new Error('OCR listener did not keep the response channel open'));setTimeout(()=>reject(new Error('OCR response timeout')),30000);});});expect(result.ok).toBe(true);expect(result.text.toLowerCase()).toContain('zquiet');expect(result.diagnostic.elapsed_ms).toBeGreaterThan(0);await page.close(); }, 60_000);
  test('trap fixture produces zero accepted candidates', async () => { const page=await instrument('false-positive-trap.html');expect(await codes(page)).toEqual([]);await page.close(); });
});

describe('Affiliate form assistant browser fixture', () => {
  test('associates Partnerize sibling labels with their own input instead of the first form label', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/empty.html`);
    await page.setContent(`
      <div class="Fields">
        <span class="DesktopLabel" data-name="label">Email address</span>
        <div class="InputForm"><div><input id="email_address" name="email_address" placeholder="Value"></div></div>
        <div class="FieldMeta"></div>
        <span class="DesktopLabel" data-name="label">Username</span>
        <div class="InputForm"><div><input id="user_name" name="user_name" placeholder="Value"></div></div>
        <div class="FieldMeta"></div>
        <span class="DesktopLabel" data-name="label">Company name</span>
        <div class="InputForm"><div><input id="company_name" name="company_name" placeholder="Value"></div></div>
        <div class="FieldMeta"></div>
        <span class="DesktopLabel" data-name="label">Address line 1</span>
        <div class="InputForm"><div><input id="address_1" name="address_1" placeholder="Value"></div></div>
        <div class="FieldMeta"></div>
        <span class="DesktopLabel" data-name="label">Post/Zip code</span>
        <div class="InputForm"><div><input id="post_code" name="post_code" placeholder="Value"></div></div>
        <div class="FieldMeta"></div>
        <span class="DesktopLabel" data-name="label">Website URL</span>
        <div class="InputForm"><div><input id="website" name="website" placeholder="Value"></div></div>
      </div>
    `);
    await page.addScriptTag({ type: 'module', content: `import * as helper from '${base}/form-assistant.mjs'; window.__formHelper = helper;` });
    await page.waitForFunction(() => Boolean(window.__formHelper));
    const labels = await page.evaluate(() => Object.fromEntries(
      window.__formHelper.scanForm(document, 0).fields.map((field) => [field.name, field.label]),
    ));
    expect(labels).toEqual({
      email_address: 'Email address', user_name: 'Username', company_name: 'Company name',
      address_1: 'Address line 1', post_code: 'Post/Zip code', website: 'Website URL',
    });
    await page.close();
  });

  test('scans ordinary and shadow fields, then fills Title plus local Password confirmation', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/empty.html`);
    await page.setContent(`
      <label>Title <input name="title"></label>
      <label>Password <input name="password" type="password"></label>
      <label>Confirm Password <input name="confirmPassword" type="password"></label>
      <div id="shadow"></div>
    `);
    await page.evaluate(() => {
      const root = document.querySelector('#shadow').attachShadow({ mode: 'open' });
      root.innerHTML = '<label>Company Role <input name="companyRole"></label>';
    });
    await page.addScriptTag({ type: 'module', content: `import * as helper from '${base}/form-assistant.mjs'; window.__formHelper = helper;` });
    await page.waitForFunction(() => Boolean(window.__formHelper));
    const result = await page.evaluate(() => {
      const helper = window.__formHelper;
      const scan = helper.scanForm(document, 2);
      const byName = Object.fromEntries(scan.fields.map((field) => [field.name, field]));
      const plan = { fields: [
        { dom_id: byName.title.dom_id, field_key: 'title', value: 'Founder' },
        { dom_id: byName.password.dom_id, field_key: 'local_password', value: 'LocalPass9!', locally_managed_secret: true },
        { dom_id: byName.confirmPassword.dom_id, field_key: 'local_password_confirmation', value: 'LocalPass9!', locally_managed_secret: true },
      ] };
      return { scan, applied: helper.applyPlan(plan, document), values: {
        title: document.querySelector('[name="title"]').value,
        password: document.querySelector('[name="password"]').value,
        confirm: document.querySelector('[name="confirmPassword"]').value,
      } };
    });
    expect(result.scan.fields.map((field) => field.name)).toEqual(expect.arrayContaining([
      'title', 'password', 'confirmPassword', 'companyRole',
    ]));
    expect(result.scan.fields.find((field) => field.name === 'password').unsafe).toBe(true);
    expect(result.applied.filled).toHaveLength(3);
    expect(result.values).toEqual({ title: 'Founder', password: 'LocalPass9!', confirm: 'LocalPass9!' });
    await page.close();
  });

  test('fills both password boxes and switches the pair to fallback password after site rejection', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/empty.html`);
    await page.setContent(`
      <label>Password <input name="password" type="password"></label>
      <label>Confirm Password <input name="confirmPassword" type="password"></label>
    `);
    await page.addScriptTag({ type: 'module', content: `import * as helper from '${base}/form-assistant.mjs'; window.__formHelper = helper;` });
    await page.waitForFunction(() => Boolean(window.__formHelper));
    const values = await page.evaluate(async () => {
      const password = document.querySelector('[name="password"]');
      password.addEventListener('input', () => password.setCustomValidity(password.value.endsWith('!') ? 'Rejected by site' : ''));
      const scan = window.__formHelper.scanForm(document, 0);
      const byName = Object.fromEntries(scan.fields.map((field) => [field.name, field]));
      const common = {
        value: 'TroveCoupon2026!', value_candidates: ['TroveCoupon2026!', 'TroveCoupon2026'],
        local_secret_group: 'profile_1', locally_managed_secret: true,
        sensitive: true, confirmed_sensitive: true,
      };
      window.__formHelper.applyPlan({ fields: [
        { ...common, dom_id: byName.password.dom_id, field_key: 'local_password' },
        { ...common, dom_id: byName.confirmPassword.dom_id, field_key: 'local_password_confirmation' },
      ] }, document);
      const initial = [password.value, document.querySelector('[name="confirmPassword"]').value];
      password.reportValidity();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { initial, fallback: [password.value, document.querySelector('[name="confirmPassword"]').value] };
    });
    expect(values.initial).toEqual(['TroveCoupon2026!', 'TroveCoupon2026!']);
    expect(values.fallback).toEqual(['TroveCoupon2026', 'TroveCoupon2026']);
    await page.close();
  });

  test('prioritizes an open popup and scans plus fills its same-origin iframe instead of page background', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/empty.html`);
    await page.setContent(`
      <label>Background field <input name="background"></label>
      <dialog id="signup">
        <label>Popup name <input name="popupName"></label>
        <iframe id="formFrame" srcdoc='<label>Popup company <input name="popupCompany"></label>'></iframe>
      </dialog>
    `);
    await page.evaluate(() => document.querySelector('#signup').showModal());
    await page.waitForFunction(() => document.querySelector('#formFrame').contentDocument?.querySelector('[name="popupCompany"]'));
    await page.addScriptTag({ type: 'module', content: `import * as helper from '${base}/form-assistant.mjs'; window.__formHelper = helper;` });
    await page.waitForFunction(() => Boolean(window.__formHelper));
    const result = await page.evaluate(() => {
      const scan = window.__formHelper.scanForm(document, 3);
      const byName = Object.fromEntries(scan.fields.map((field) => [field.name, field]));
      const applied = window.__formHelper.applyPlan({ fields: [
        { dom_id: byName.popupName.dom_id, field_key: 'first_name', value: 'Trove' },
        { dom_id: byName.popupCompany.dom_id, field_key: 'company', value: 'TroveCoupon' },
      ] }, document);
      return { scan, applied, values: {
        background: document.querySelector('[name="background"]').value,
        popupName: document.querySelector('[name="popupName"]').value,
        popupCompany: document.querySelector('#formFrame').contentDocument.querySelector('[name="popupCompany"]').value,
      } };
    });
    expect(result.scan.surface).toBe('popup');
    expect(result.scan.fields.map((field) => field.name)).toEqual(['popupName', 'popupCompany']);
    expect(result.applied.filled).toHaveLength(2);
    expect(result.values).toEqual({ background: '', popupName: 'Trove', popupCompany: 'TroveCoupon' });
    await page.close();
  });
});
