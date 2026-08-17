import test from 'node:test';
import assert from 'node:assert/strict';
import {
  affiliateTabMatches, chooseAffiliateRecoveryTab, recoverableAffiliateJob, recoveredAffiliateState,
} from './affiliate-recovery.mjs';

const job = {
  job_id: 'aaj_active', application_host: 'affiliate.example.com',
  application_url: 'https://affiliate.example.com/register', profile_id: 4,
  status: 'needs_user', fill_plan: { fields: [{ dom_id: 'email', value: 'a@example.com' }] },
};

test('affiliate recovery accepts only a live job on the exact HTTPS host', () => {
  assert.equal(recoverableAffiliateJob(job), true);
  assert.equal(recoverableAffiliateJob({ ...job, status: 'submitted' }), false);
  assert.equal(affiliateTabMatches(job, { id: 8, url: 'https://affiliate.example.com/step/2' }), true);
  assert.equal(affiliateTabMatches(job, { id: 8, url: 'http://affiliate.example.com/step/2' }), false);
  assert.equal(affiliateTabMatches(job, { id: 8, url: 'https://evil.example.com/' }), false);
});

test('affiliate recovery prefers the active exact-host tab and creates a complete session patch', () => {
  const chosen = chooseAffiliateRecoveryTab(job, [
    { id: 2, url: 'https://affiliate.example.com/old', lastAccessed: 200 },
    { id: 3, url: 'https://affiliate.example.com/current', active: true, lastAccessed: 100 },
    { id: 4, url: 'https://unrelated.example.com/', active: true, lastAccessed: 300 },
  ]);
  assert.equal(chosen.id, 3);
  const state = recoveredAffiliateState(job, chosen, job.fill_plan);
  assert.equal(state.affiliate_application_tab_id, 3);
  assert.equal(state.affiliate_application_command.job_id, job.job_id);
  assert.deepEqual(state.affiliate_fill_plan, job.fill_plan);
  assert.equal(state.helper_context.mode, 'affiliate');
  assert.equal(state.affiliate_auto_fill_pending, true);
});
