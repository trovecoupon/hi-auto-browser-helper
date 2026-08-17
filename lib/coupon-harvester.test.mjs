import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateToCoupon, harvesterCouponToBlock, mergeHarvesterCoupons, scoreHarvesterCandidate, validateHarvesterCode } from './coupon-harvester.mjs';

const base = { rawCode: 'WELCOME20', hostname: 'shop.test', sourceUrl: 'https://shop.test/coupon', detectedBy: ['text'], explicitLabel: true, nearKeyword: true, firstSeen: 1, lastSeen: 2 };

test('harvester scorer rejects traps and accepts explicit labelled codes', () => {
  for (const value of ['COPY', '$4.49', '2026-08-12', '#AABBCC', 'https://x.test', 'a@x.test']) assert.equal(validateHarvesterCode(value).valid, false);
  assert.equal(scoreHarvesterCandidate(base).decision, 'review');
  assert.equal(scoreHarvesterCandidate({ ...base, detectedBy: ['clipboard'] }).decision, 'auto_save');
});

test('harvester dedup merges runtime evidence and maps it into discovery blocks', () => {
  const first = candidateToCoupon(base, scoreHarvesterCandidate(base));
  const runtimeCandidate = { ...base, detectedBy: ['network'], firstSeen: 2, lastSeen: 9 };
  const second = candidateToCoupon(runtimeCandidate, scoreHarvesterCandidate(runtimeCandidate));
  const merged = mergeHarvesterCoupons([first], [second]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].detectedBy.sort(), ['network', 'text']);
  assert.equal(harvesterCouponToBlock(merged[0]).method, 'network');
});
