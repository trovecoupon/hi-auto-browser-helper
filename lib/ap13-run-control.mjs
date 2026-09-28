// Discovery admission only. Backend queue/lease/checkpoint remain authoritative.
// Session storage survives service-worker suspension, not an entire browser reset.
import { isTerminalJob } from './job-orchestrator.mjs';

export function createRunControl({ read, write, start, stop, save, progress, finish }) {
  let tail = Promise.resolve();
  let pending = 0;
  async function apply(action, payload) {
    if (action !== 'STOP' && (!payload?.job_id || !payload?.session_id)) throw new Error('job_identity_required');
    const state = await read();
    const same = state?.job_id === payload?.job_id && state?.session_id === payload?.session_id;
    if (action === 'START') {
      if (state && !isTerminalJob(state)) {
        if (!same) throw new Error('another_job_active');
        if (state.stop_requested) throw new Error('stop_pending');
        if (state.status === 'starting') throw new Error('start_needs_reconciliation');
        return { ok: true, idempotent: true, job_id: state.job_id, status: state.status };
      }
      if (same) throw new Error('terminal_job_requires_authoritative_resume');
      const starting = { job_id: payload.job_id, session_id: payload.session_id, stop_requested: false, status: 'starting' };
      await write(starting);
      // Failed start stays recoverable; never open a second tab by retrying blindly.
      const result = await start(payload);
      await write({ ...starting, status: 'active' });
      return result;
    }
    if (action === 'STOP') {
      if (!state) return { ok: true };
      if (state.job_id !== payload?.job_id) throw new Error('job_identity_mismatch');
      if (state.status === 'stopped') return { ok: true, idempotent: true };
      const barrier = { ...state, stop_requested: true, status: 'stopping' };
      await write(barrier);
      const result = await stop(payload);
      await write({ ...barrier, status: 'stopped' });
      return result;
    }
    if (!same) throw new Error('job_identity_mismatch');
    if (state.stop_requested || state.status !== 'active') throw new Error('job_not_accepting_units');
    const handler = { SAVE: save, PROGRESS: progress, FINISH: finish }[action];
    if (!handler) throw new Error('unsupported_command');
    const result = await handler(payload);
    if (action === 'PROGRESS' && isTerminalJob(result)) await write({ ...state, status: result.status });
    if (action === 'FINISH') await write({ ...state, status: 'completed' });
    return result;
  }
  return {
    execute(action, payload) {
      // Bounded local sequencing; no persistent job queue or background polling.
      if (pending >= 64) return Promise.reject(new Error('control_busy'));
      pending += 1;
      const snapshot = structuredClone(payload);
      const call = tail.then(() => apply(action, snapshot));
      tail = call.catch(() => {}).finally(() => { pending -= 1; });
      return call;
    },
  };
}
