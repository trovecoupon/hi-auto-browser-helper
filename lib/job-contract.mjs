// AP03 projection only. The backend owner must persist accepted revisions by CAS.
const TERMINAL_CHILD = new Set(['succeeded', 'failed', 'skipped']);
const TERMINAL_JOB = new Set(['completed', 'failed', 'cancelled']);
const NATIVE = Object.freeze({
  affiliate: {
    queued: ['queued', null, 'unknown'], researching: ['running', null, 'unknown'],
    retry: ['queued', 'error', 'preserved'], program_found: ['completed', 'success', 'partial'],
    no_program: ['completed', 'no_data', 'available'],
    needs_manual_review: ['completed', 'blocked', 'preserved'],
    complete: ['completed', 'success', 'available'],
  },
  keyword_helper: {
    queued: ['queued', null, 'unknown'], running: ['running', null, 'unknown'],
    needs_login: ['running', 'blocked', 'preserved'], needs_user: ['running', 'blocked', 'preserved'],
    completed: ['completed', 'success', 'available'], failed: ['failed', 'error', 'preserved'],
    cancelled: ['cancelled', null, 'preserved'],
  },
  ads_discovery: {
    starting: ['queued', null, 'unknown'], running: ['running', null, 'unknown'],
    paused: ['running', 'blocked', 'preserved'], stopping: ['cancel_requested', null, 'preserved'],
    stopped: ['cancelled', null, 'preserved'], completed: ['completed', 'success', 'available'],
    partial: ['completed', 'success', 'partial'], captcha: ['failed', 'blocked', 'preserved'],
    context_mismatch: ['failed', 'error', 'preserved'], timeout: ['failed', 'timeout', 'preserved'],
    disconnected: ['failed', 'error', 'preserved'], failed: ['failed', 'error', 'preserved'],
  },
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function logicalJobKey(domain, scope, collectorVersion) {
  if (typeof domain !== 'string' || !domain || !scope || Array.isArray(scope)
      || typeof scope !== 'object' || typeof collectorVersion !== 'string' || !collectorVersion) {
    throw new Error('domain, scope and collector_version are required');
  }
  return `job/1:${canonical([domain, scope, collectorVersion])}`;
}

export function mapNative(source, status) {
  const mapped = NATIVE[source]?.[status];
  if (!mapped) return { job_state: 'unknown', attempt_outcome: null, data_state: 'unknown', reason: 'unmapped_native_status' };
  const [job_state, attempt_outcome, data_state] = mapped;
  return { job_state, attempt_outcome, data_state, reason: null };
}

export function newProjection({ operation_id, logical_key, epoch, revision, lease_owner,
  lease_expires_at, subscribers = [], data_state = 'unknown' }) {
  if (!operation_id || !logical_key || !Number.isInteger(revision) || revision < 0
      || (epoch !== null && (!Number.isInteger(epoch) || epoch < 0))) throw new Error('invalid operation/revision/epoch');
  return {
    schema_version: 1, operation_id, logical_key, epoch, revision, lease_owner,
    lease_expires_at, subscribers: [...new Set(subscribers)].sort(),
    job_state: lease_owner ? 'running' : 'queued', attempt_outcome: null,
    data_state, input_sealed: false, finalized: false, children: {}, checkpoint: null,
  };
}

export function progress(state) {
  const processed = Object.values(state.children).filter((item) => TERMINAL_CHILD.has(item.state)).length;
  const total = state.input_sealed ? Object.keys(state.children).length : null;
  const percent = total && state.finalized ? Math.round(100 * processed / total) : null;
  return { processed, total, percent, no_work: Boolean(state.input_sealed && total === 0) };
}

function leaseValid(state, event, now) {
  if (state.epoch === null || !state.lease_owner || !state.lease_expires_at
      || !/(Z|[+-]\d\d:\d\d)$/.test(state.lease_expires_at)
      || !/(Z|[+-]\d\d:\d\d)$/.test(now)) return false;
  const expiry = Date.parse(state.lease_expires_at); const instant = Date.parse(now);
  return Number.isFinite(expiry) && Number.isFinite(instant) && instant < expiry
    && event.epoch === state.epoch && event.lease_owner === state.lease_owner;
}

export function applyEvent(state, event, now) {
  const kind = event.kind;
  if (event.operation_id !== state.operation_id || event.expected_revision !== state.revision) {
    return [state, 'stale_revision_or_operation'];
  }
  if (kind === 'tab_closed') return [state, 'transport_only'];
  if (kind === 'cancel_requested') {
    if (!state.subscribers.includes(event.principal)) return [state, 'not_subscribed'];
    const next = structuredClone(state);
    next.subscribers = next.subscribers.filter((name) => name !== event.principal);
    if (!next.subscribers.length && !TERMINAL_JOB.has(next.job_state)) next.job_state = 'cancel_requested';
    next.revision += 1;
    return [next, 'accepted'];
  }
  if (!['child', 'seal_input', 'finish', 'cancel_ack'].includes(kind)) return [state, 'unknown_event'];
  if (!leaseValid(state, event, now)) return [state, 'lease_or_epoch_lost'];
  if (TERMINAL_JOB.has(state.job_state)) return [state, 'terminal_job'];
  if (state.job_state === 'cancel_requested' && kind !== 'cancel_ack') return [state, 'cancel_pending'];
  const next = structuredClone(state);
  if (kind === 'child') {
    const { logical_key: key, attempt, seq, state: childState } = event;
    if (typeof key !== 'string' || !key || !Number.isInteger(attempt) || attempt < 1
        || !Number.isInteger(seq) || seq < 1
        || !(TERMINAL_CHILD.has(childState) || childState === 'running')) return [state, 'invalid_child'];
    const old = next.children[key];
    if (old && (attempt < old.attempt || (attempt === old.attempt && seq <= old.seq))) return [state, 'stale_child'];
    if (next.input_sealed && !old) return [state, 'input_sealed'];
    next.children[key] = { attempt, seq, state: childState };
    if (Object.hasOwn(event, 'checkpoint')) next.checkpoint = event.checkpoint;
  } else if (kind === 'seal_input') {
    if (next.input_sealed) return [state, 'already_sealed'];
    next.input_sealed = true;
  } else if (kind === 'finish') {
    if (!next.input_sealed || Object.values(next.children).some((child) => !TERMINAL_CHILD.has(child.state))) {
      return [state, 'unfinished_input'];
    }
    const outcome = event.attempt_outcome;
    if (!['success', 'no_data', 'blocked', 'rate_limited', 'quota_exhausted', 'timeout', 'error'].includes(outcome)) {
      return [state, 'invalid_outcome'];
    }
    next.finalized = true;
    next.job_state = ['success', 'no_data'].includes(outcome) ? 'completed' : 'failed';
    next.attempt_outcome = outcome;
    next.data_state = event.data_state ?? next.data_state;
    next.lease_owner = null; next.lease_expires_at = null;
  } else {
    if (next.job_state !== 'cancel_requested') return [state, 'cancel_not_requested'];
    next.job_state = 'cancelled'; next.lease_owner = null; next.lease_expires_at = null;
  }
  next.revision += 1;
  return [next, 'accepted'];
}
