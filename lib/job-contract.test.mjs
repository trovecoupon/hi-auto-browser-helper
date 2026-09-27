import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, logicalJobKey, mapNative, newProjection, progress } from './job-contract.mjs';

const now = '2026-09-27T12:00:00Z';
const fresh = (opts = {}) => newProjection({
  operation_id: 'op-1', logical_key: 'job/1:fixture', epoch: 4, revision: 0,
  lease_owner: 'worker-b', lease_expires_at: '2026-09-27T12:01:00Z',
  subscribers: ['alice'], ...opts,
});
const workerEvent = (state, kind, extra = {}) => ({
  kind, operation_id: 'op-1', expected_revision: state.revision, epoch: 4,
  lease_owner: 'worker-b', ...extra,
});
const accepted = (state, kind, extra = {}) => {
  const [next, decision] = applyEvent(state, workerEvent(state, kind, extra), now);
  assert.equal(decision, 'accepted');
  return next;
};

test('native status maps job, attempt and data independently', () => {
  assert.deepEqual(mapNative('ads_discovery', 'partial'), {
    job_state: 'completed', attempt_outcome: 'success', data_state: 'partial', reason: null,
  });
  assert.equal(mapNative('ads_discovery', 'captcha').attempt_outcome, 'blocked');
  assert.equal(mapNative('ads_discovery', 'disconnected').data_state, 'preserved');
  assert.equal(mapNative('keyword_helper', 'needs_login').attempt_outcome, 'blocked');
  assert.equal(mapNative('affiliate', 'not-real').job_state, 'unknown');
});

test('logical key is stable and includes entire scope and collector version', () => {
  const a = logicalJobKey('example.test', { geo: 'US', device: 'desktop' }, 'v1');
  assert.equal(a, logicalJobKey('example.test', { device: 'desktop', geo: 'US' }, 'v1'));
  assert.notEqual(a, logicalJobKey('example.test', { geo: 'VN', device: 'desktop' }, 'v1'));
  assert.notEqual(a, logicalJobKey('example.test', { geo: 'US', device: 'desktop' }, 'v2'));
  assert.equal(a, 'job/1:["example.test",{"device":"desktop","geo":"US"},"v1"]');
});

test('late lease and duplicate attempt cannot replace a newer checkpoint', () => {
  let state = fresh();
  const stale = workerEvent(state, 'child', { logical_key: 'a', attempt: 1, seq: 1,
    state: 'succeeded', checkpoint: 'old', epoch: 3, lease_owner: 'worker-a' });
  assert.deepEqual(applyEvent(state, stale, now), [state, 'lease_or_epoch_lost']);
  state = accepted(state, 'child', { logical_key: 'a', attempt: 2, seq: 2,
    state: 'succeeded', checkpoint: 'new' });
  const duplicate = workerEvent(state, 'child', { logical_key: 'a', attempt: 2, seq: 2,
    state: 'failed', checkpoint: 'bad' });
  assert.deepEqual(applyEvent(state, duplicate, now), [state, 'stale_child']);
  assert.equal(state.checkpoint, 'new');
});

test('retry counts logical item once; unknown and zero totals have no fake percentage', () => {
  let state = accepted(fresh(), 'child', { logical_key: 'a', attempt: 1, seq: 1, state: 'failed' });
  assert.deepEqual(progress(state), { processed: 1, total: null, percent: null, no_work: false });
  state = accepted(state, 'child', { logical_key: 'a', attempt: 2, seq: 1, state: 'succeeded' });
  assert.equal(progress(state).processed, 1);
  state = accepted(state, 'seal_input');
  assert.equal(progress(state).percent, null);
  state = accepted(state, 'finish', { attempt_outcome: 'error', data_state: 'partial' });
  assert.deepEqual(progress(state), { processed: 1, total: 1, percent: 100, no_work: false });
  assert.equal(state.job_state, 'failed');
  let empty = accepted(fresh(), 'seal_input');
  empty = accepted(empty, 'finish', { attempt_outcome: 'no_data' });
  assert.deepEqual(progress(empty), { processed: 0, total: 0, percent: null, no_work: true });
});

test('subscriber cancellation preserves committed work; tab close is transport only', () => {
  let state = fresh({ subscribers: ['alice', 'bob'] });
  state = accepted(state, 'child', { logical_key: 'a', attempt: 1, seq: 1,
    state: 'succeeded', checkpoint: 'committed' });
  assert.deepEqual(applyEvent(state, workerEvent(state, 'tab_closed'), now), [state, 'transport_only']);
  let event = { kind: 'cancel_requested', operation_id: 'op-1', expected_revision: state.revision, principal: 'alice' };
  [state] = applyEvent(state, event, now);
  assert.equal(state.job_state, 'running');
  event = { ...event, expected_revision: state.revision, principal: 'bob' };
  [state] = applyEvent(state, event, now);
  assert.equal(state.job_state, 'cancel_requested');
  assert.equal(applyEvent(state, workerEvent(state, 'child', {
    logical_key: 'b', attempt: 1, seq: 1, state: 'succeeded',
  }), now)[1], 'cancel_pending');
  state = accepted(state, 'cancel_ack');
  assert.equal(state.job_state, 'cancelled');
  assert.equal(state.checkpoint, 'committed');
  assert.equal(state.lease_owner, null);
});

test('legacy missing fencing and outsider cancellation are rejected', () => {
  const legacy = fresh({ epoch: null });
  assert.equal(applyEvent(legacy, workerEvent(legacy, 'seal_input'), now)[1], 'lease_or_epoch_lost');
  const state = fresh();
  assert.equal(applyEvent(state, { kind: 'cancel_requested', operation_id: 'op-1',
    expected_revision: 0, principal: 'mallory' }, now)[1], 'not_subscribed');
});
