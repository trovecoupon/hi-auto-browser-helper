import test from 'node:test';
import assert from 'node:assert/strict';

// This test travels with the candidate module when the two files are staged
// together. It has no Chrome, backend, network, or filesystem fixture.
const { createRunControl } = await import('./ap13-run-control.mjs');

const job = (job_id = 'adsjob_111', session_id = 'session-1') => ({ job_id, session_id });

function harness(overrides = {}) {
  let persisted = null;
  const calls = { start: 0, stop: 0, save: 0, progress: 0, finish: 0 };
  const adapter = {
    read: async () => structuredClone(persisted),
    write: async (state) => { persisted = structuredClone(state); },
    start: async () => { calls.start += 1; return { ok: true }; },
    stop: async () => { calls.stop += 1; return { ok: true }; },
    save: async () => { calls.save += 1; return { ok: true }; },
    progress: async () => { calls.progress += 1; return { ok: true }; },
    finish: async () => { calls.finish += 1; return { ok: true }; },
    ...overrides,
  };
  return { control: createRunControl(adapter), adapter, calls, state: () => structuredClone(persisted) };
}

test('double-click START is serialized and opens one job only', async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.control.execute('START', job()),
    h.control.execute('START', job()),
  ]);
  assert.equal(h.calls.start, 1);
  assert.equal(h.state().job_id, job().job_id);
  assert.equal(h.state().session_id, job().session_id);
  assert.equal(h.state().stop_requested, false);
  assert.equal(second.idempotent, true);
  assert.ok(first);
});

test('START rejects another active job and does not replace its identity', async () => {
  const h = harness();
  await h.control.execute('START', job());
  await assert.rejects(h.control.execute('START', job('adsjob_222', 'session-2')));
  assert.equal(h.calls.start, 1);
  assert.equal(h.state().job_id, job().job_id);
});

test('STOP persists a barrier before backend callback and retains it on failure', async () => {
  let h;
  h = harness({ stop: async () => {
    h.calls.stop += 1;
    assert.equal(h.state().stop_requested, true);
    assert.equal(h.state().status, 'stopping');
    throw new Error('backend unavailable');
  } });
  await h.control.execute('START', job());
  await assert.rejects(h.control.execute('STOP', job()), /backend unavailable/);
  assert.equal(h.state().stop_requested, true);
  assert.equal(h.calls.stop, 1);
  await assert.rejects(h.control.execute('SAVE', job()));
  await assert.rejects(h.control.execute('PROGRESS', job()));
  await assert.rejects(h.control.execute('FINISH', job()));
  assert.equal(h.calls.save + h.calls.progress + h.calls.finish, 0);
});

test('STOP waits for an accepted in-flight unit, then rejects newly queued units', async () => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const h = harness({ save: async () => { h.calls.save += 1; await gate; return { ok: true }; } });
  await h.control.execute('START', job());
  const first = h.control.execute('SAVE', job());
  const stop = h.control.execute('STOP', job());
  const late = h.control.execute('SAVE', job());
  await Promise.resolve();
  unblock();
  await first;
  await stop;
  await assert.rejects(late);
  assert.equal(h.calls.save, 1);
  assert.equal(h.calls.stop, 1);
  assert.equal(h.state().stop_requested, true);
});

test('unit callbacks require the exact active job and session', async () => {
  const h = harness();
  await h.control.execute('START', job());
  await assert.rejects(h.control.execute('SAVE', job('adsjob_111', 'session-other')));
  await assert.rejects(h.control.execute('PROGRESS', job('adsjob_other', 'session-1')));
  assert.equal(h.calls.save + h.calls.progress, 0);
  await h.control.execute('SAVE', job());
  await h.control.execute('PROGRESS', job());
  assert.equal(h.calls.save, 1);
  assert.equal(h.calls.progress, 1);
});
test('failed browser opening retains starting; newly paired session can STOP same job', async () => {
  let h;
  h = harness({ start: async () => {
    h.calls.start += 1;
    throw new Error('fixture opening failed');
  } });
  await assert.rejects(h.control.execute('START', job()), /fixture opening failed/);
  assert.deepEqual(h.state(), { job_id: 'adsjob_111', session_id: 'session-1',
    status: 'starting', stop_requested: false });
  const reconnected = createRunControl(h.adapter);
  const result = await reconnected.execute('STOP', job('adsjob_111', 'session-new'));
  assert.equal(result.ok, true);
  assert.equal(h.calls.start, 1);
  assert.equal(h.calls.stop, 1);
  assert.equal(h.state().job_id, 'adsjob_111');
  assert.equal(h.state().status, 'stopped');
  assert.equal(h.state().stop_requested, true);
});

test('STOP without stored state is an idempotent success and does not call backend', async () => {
  const h = harness();
  assert.deepEqual(await h.control.execute('STOP', job()), { ok: true });
  assert.equal(h.calls.stop, 0);
  assert.equal(h.state(), null);
});

test('new pairing may STOP active same job while stale SAVE and PROGRESS remain fenced', async () => {
  const h = harness();
  await h.control.execute('START', job());
  for (const action of ['SAVE', 'PROGRESS']) {
    await assert.rejects(h.control.execute(action, job('adsjob_111', 'session-new')),
      /job_identity_mismatch/);
  }
  assert.equal(h.calls.save, 0);
  assert.equal(h.calls.progress, 0);
  assert.equal(h.state().status, 'active');
  await h.control.execute('SAVE', job());
  await h.control.execute('PROGRESS', job());
  assert.equal(h.calls.save, 1);
  assert.equal(h.calls.progress, 1);
  assert.equal((await h.control.execute('STOP', job('adsjob_111', 'session-new'))).ok, true);
  assert.equal(h.calls.stop, 1);
  assert.equal(h.state().status, 'stopped');
});

test('STOP for another job cannot stop or overwrite the active identity', async () => {
  const h = harness();
  await h.control.execute('START', job());
  const before = h.state();
  await assert.rejects(h.control.execute('STOP', job('adsjob_other', 'session-new')),
    /job_identity_mismatch/);
  assert.equal(h.calls.stop, 0);
  assert.deepEqual(h.state(), before);
});

