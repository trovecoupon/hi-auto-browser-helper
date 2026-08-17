import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_BRIDGE_URL, agentSessionState, bridgeHealth, normalizePairingCode, pairWithAgent,
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

test('bridge reports an actionable offline error and session expiry', async () => {
  await assert.rejects(() => bridgeHealth(async () => { throw new Error('refused'); }), /HiAuto_LocalAgent/);
  assert.equal(agentSessionState(null), 'unpaired');
  assert.equal(agentSessionState({ helper_token: 'x', expires_at: '2026-08-17T10:00:00Z' }, Date.parse('2026-08-17T09:00:00Z')), 'connected');
  assert.equal(agentSessionState({ helper_token: 'x', expires_at: '2026-08-17T10:00:00Z' }, Date.parse('2026-08-17T10:00:00Z')), 'expired');
});

test('bridge preserves structured Local Agent failures', async () => {
  await assert.rejects(
    () => pairWithAgent('123456', async () => response(401, {
      ok: false, error_code: 'pairing_invalid', message: 'Mã sai hoặc hết hạn.',
    })),
    (error) => error.code === 'pairing_invalid' && /hết hạn/.test(error.message),
  );
});
