import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_BRIDGE_URL, AGENT_JOB_HEARTBEAT_MS, agentSessionState, bridgeHealth, heartbeatAgentJob,
  keepAgentJobLease, localApiViaAgent, normalizePairingCode, pairWithAgent,
} from './agent-bridge.mjs';

function response(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

test('agent bridge is loopback-only and pairing accepts exactly six digits', async () => {
  assert.equal(AGENT_BRIDGE_URL, 'http://127.0.0.1:8771');
  assert.equal(normalizePairingCode(' 123 456 '), '123456');
  assert.throws(() => normalizePairingCode('12345'), /6 số/);
  const calls = [];
  const value = await pairWithAgent('123456', async (url, options) => {
    calls.push({ url, options });
    return response(200, { ok: true, helper_token: 'fixture', expires_at: '2099-01-01T00:00:00Z' });
  });
  assert.equal(value.helper_token, 'fixture');
  assert.equal(calls[0].url, 'http://127.0.0.1:8771/v1/pair');
  assert.equal(JSON.parse(calls[0].options.body).code, '123456');
});

test('bridge reports an actionable offline error; local clock never expires a session', async () => {
  await assert.rejects(() => bridgeHealth(async () => { throw new Error('refused'); }), /HiAuto_LocalAgent/);
  assert.equal(agentSessionState(null), 'unpaired');
  assert.equal(agentSessionState({ helper_token: 'x', expires_at: '2026-08-17T10:00:00Z' }), 'connected');
  // Phiên server là phiên TRƯỢT — expires_at cục bộ đã qua vẫn phải THỬ, chỉ server mới khai tử.
  assert.equal(agentSessionState({ helper_token: 'x', expires_at: '1999-01-01T00:00:00Z' }), 'connected');
});

test('bridge preserves structured Local Agent failures', async () => {
  await assert.rejects(
    () => pairWithAgent('123456', async () => response(401, {
      ok: false, error_code: 'pairing_invalid', message: 'Mã sai hoặc hết hạn.',
    })),
    (error) => error.code === 'pairing_invalid' && /hết hạn/.test(error.message),
  );
});

test('local API uses the Agent token and preserves backend failures', async () => {
  const calls = [];
  const result = await localApiViaAgent('/api/projects', 'agent-token', {
    adsToken: 'ads-token', fetchFn: async (url, options) => {
      calls.push({ url, options });
      return response(200, { ok: true, status: 200, data: { items: [7] } });
    },
  });
  assert.deepEqual(result, { items: [7] });
  assert.equal(calls[0].url, 'http://127.0.0.1:8771/v1/api');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer agent-token');
  assert.equal(JSON.parse(calls[0].options.body).ads_token, 'ads-token');

  await assert.rejects(() => localApiViaAgent('/api/projects', 'agent-token', {
    fetchFn: async () => response(200, {
      ok: true, status: 409, data: { detail: { code: 'busy', message: 'Äang báº­n.' } },
    }),
  }), (error) => error.status === 409 && error.code === 'busy');
});

// CC-55 (CC-51-F02): job extension phải gia hạn lease 90 s của Agent trong lúc chạy.
test('job lease heartbeat keeps the Agent lease, survives a transient error and stops cleanly', async () => {
  assert.ok(AGENT_JOB_HEARTBEAT_MS < 90_000 / 2, 'phải còn ít nhất hai nhịp trước khi lease 90 s hết');
  const calls = [];
  await heartbeatAgentJob('local_1', 'agent-token', async (url, options) => {
    calls.push({ url, options }); return response(200, { ok: true, job: { status: 'leased' } });
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:8771/v1/jobs/local_1/heartbeat');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer agent-token');

  let tick = null; let cleared = 0; const beats = [];
  const replies = [() => { throw new TypeError('Failed to fetch'); }, () => response(200, { ok: true })];
  const lease = keepAgentJobLease('local_2', 'agent-token', {
    fetchFn: async (url) => { beats.push(url); return (replies.shift() || (() => response(200, { ok: true })))(); },
    setIntervalFn: (fn, ms) => { assert.equal(ms, AGENT_JOB_HEARTBEAT_MS); tick = fn; return 7; },
    clearIntervalFn: (id) => { assert.equal(id, 7); cleared += 1; },
  });
  tick(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lease.lost, null, 'lỗi mạng tạm không được coi là mất lease');
  tick(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(beats.length, 2);
  lease.stop(); tick();
  assert.equal(beats.length, 2, 'sau stop() không còn heartbeat');
  assert.equal(cleared, 1);
});

test('job lease heartbeat reports a lost lease instead of hiding it', async () => {
  let tick = null;
  const lease = keepAgentJobLease('local_3', 'agent-token', {
    fetchFn: async () => response(409, { ok: false, error_code: 'local_lease_invalid', message: 'hết hạn' }),
    setIntervalFn: (fn) => { tick = fn; return 1; }, clearIntervalFn: () => {},
  });
  tick(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lease.lost?.code, 'local_lease_invalid');
  lease.stop();
});
