import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarvesterRuntime } from './coupon-harvester-runtime.mjs';

function area(initial = {}) {
  const data = { ...initial };
  return { get: async (keys) => Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])), set: async (patch) => Object.assign(data, patch), remove: async (keys) => keys.forEach((key) => delete data[key]), data };
}

test('runtime validates session namespace before storing a candidate', async () => {
  const local = area(); const session = area(); const scripts = [];
  const runtime = createHarvesterRuntime({ storageLocal: local, storageSession: session, scripting: { executeScript: async (spec) => { scripts.push(spec); return []; } }, tabs: { get: async () => ({ id: 8, url: 'https://shop.test/deals' }), sendMessage: async () => ({}) }, action: {}, notify: () => {} });
  const started = await runtime.start(8, { jobId: 2 });
  assert.equal(scripts.length, 4);
  assert.equal((await runtime.receive({ namespace: 'wrong', candidates: [] }, { tab: { id: 8 } })).reason, 'session_mismatch');
  const result = await runtime.receive({ namespace: started.namespace, candidates: [{ rawCode: 'SAVE20', hostname: 'shop.test', sourceUrl: 'https://shop.test/deals', detectedBy: ['clipboard'] }] }, { tab: { id: 8 }, url: 'https://shop.test/deals', frameId: 0 });
  assert.equal(result.accepted, 1);
  assert.equal((await runtime.snapshot(8, 2)).blocks[0].code, 'SAVE20');
});

test('child tabs inherit an active capture session and are not removed', async () => {
  const local = area(); const session = area();
  const runtime = createHarvesterRuntime({ storageLocal: local, storageSession: session, scripting: { executeScript: async () => [] }, tabs: { get: async (id) => ({ id, url: 'https://shop.test' }), sendMessage: async () => ({}) }, action: {} });
  await runtime.start(1, { jobId: 9 });
  const child = await runtime.attachChild({ id: 2, openerTabId: 1, pendingUrl: 'https://redirect.test/?coupon=X' });
  assert.equal(child.jobId, 9);
  assert.equal(child.parentTabId, 1);
});
