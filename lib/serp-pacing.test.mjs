import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SERP_DOM_STABLE_MS, SERP_MAX_PAGE_DWELL_MS, SERP_MIN_PAGE_DWELL_MS,
  nextSerpStability, serpPageDwellMs, serpSnapshotSignature,
} from './serp-pacing.mjs';

test('SERP pacing keeps every page open for a bounded human-scale delay', () => {
  assert.equal(serpPageDwellMs(() => 0), SERP_MIN_PAGE_DWELL_MS);
  assert.equal(serpPageDwellMs(() => 0.999999), SERP_MAX_PAGE_DWELL_MS);
  assert.ok(SERP_MIN_PAGE_DWELL_MS >= 3_500);
  assert.ok(SERP_MAX_PAGE_DWELL_MS <= 5_500);
  assert.ok(5 * (SERP_MIN_PAGE_DWELL_MS + SERP_DOM_STABLE_MS) >= 23_500);
});

test('SERP DOM must remain unchanged for the full stability window', () => {
  const parsed = { status: 'complete', input_count: 1,
    ads: [{ parser_fingerprint: 'ad-a' }], dropped: [] };
  const first = nextSerpStability(null, parsed, 1_000);
  const almost = nextSerpStability(first, parsed, 1_000 + SERP_DOM_STABLE_MS - 1);
  const ready = nextSerpStability(almost, parsed, 1_000 + SERP_DOM_STABLE_MS);
  assert.equal(first.stable, false);
  assert.equal(almost.stable, false);
  assert.equal(ready.stable, true);

  const changed = nextSerpStability(ready, { ...parsed, input_count: 2,
    ads: [...parsed.ads, { parser_fingerprint: 'ad-b' }] }, 3_000);
  assert.equal(changed.stable, false);
  assert.equal(changed.stable_since, 3_000);
});

test('SERP snapshot signature is deterministic and parser errors never settle', () => {
  const a = { status: 'complete', input_count: 2,
    ads: [{ parser_fingerprint: 'b' }, { parser_fingerprint: 'a' }], dropped: [] };
  const b = { ...a, ads: [...a.ads].reverse() };
  assert.equal(serpSnapshotSignature(a), serpSnapshotSignature(b));

  const failed = { status: 'error', input_count: 1, ads: [],
    dropped: [{ reason_code: 'parse_error' }] };
  const first = nextSerpStability(null, failed, 1_000);
  assert.equal(nextSerpStability(first, failed, 5_000).stable, false);
});

test('SERP content script wires dwell, stable DOM and durable ACK before navigation', async () => {
  const source = await readFile(new URL('../content/serp.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.match(source, /waitForMinimumDwell/);
  assert.match(source, /waitForStableSerp/);
  assert.match(source, /if \(!result\.acked\)/);
  assert.ok(manifest.web_accessible_resources[0].resources.includes('lib/serp-pacing.mjs'));
  assert.ok(source.indexOf('waitForMinimumDwell') < source.indexOf("location.href = nextUrl"));
  assert.ok(source.indexOf('waitForStableSerp') < source.indexOf("location.href = nextUrl"));
});
