import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  manualCreativeCollection, mergeManualCreativeObservations,
  parseAdsTransparencySnapshot, waitForAdsTransparencyProfile,
} from './parsers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'ads-transparency-profile-identity.json'), 'utf8'));

test('uses one exact advertiser breadcrumb identity when labelled details have not rendered', () => {
  const parsed = parseAdsTransparencySnapshot(fixture);
  assert.equal(parsed.profile.legal_name, 'Nutrl, Inc.');
  assert.equal(parsed.profile.reported_total, 59);
  assert.equal(parsed.profile.review_required, false);
  assert.equal(parsed.profile.field_provenance.legal_name.source, 'exact_profile_link');
});

test('labelled legal name wins over breadcrumb identity', () => {
  const parsed = parseAdsTransparencySnapshot({ ...fixture, records: [
    ...fixture.records,
    { role: 'advertiser_details', semantic_label: 'Advertiser Details', scope_path: 'details', text_lines: ['Legal name: Canonical Legal LLC', 'Headquartered in: United States'] }
  ] });
  assert.equal(parsed.profile.legal_name, 'Canonical Legal LLC');
  assert.equal(parsed.profile.field_provenance.legal_name.source, 'labelled_advertiser_details');
});

test('does not choose ambiguous advertiser headings or creative text as a legal name', () => {
  const parsed = parseAdsTransparencySnapshot({ ...fixture, records: [
    { role: 'advertiser_identity', identity_source: 'level_one_heading', value: 'First Company', text_lines: ['First Company'] },
    { role: 'advertiser_identity', identity_source: 'level_one_heading', value: 'Second Company', text_lines: ['Second Company'] },
    { creative_id: 'CR08046004961378566145', card_text: '15% Off Alp Discount Code - Verified', creative_url: 'https://adstransparency.google.com/advertiser/AR02096954062137196545/creative/CR08046004961378566145' }
  ] });
  assert.equal(parsed.profile.legal_name, null);
  assert.equal(parsed.profile.review_required, true);
  assert.ok(parsed.profile.warnings.includes('ambiguous_advertiser_identity_review_required'));
});

test('waits through an incomplete profile snapshot and returns the settled profile', async () => {
  let attempts = 0;
  const settled = await waitForAdsTransparencyProfile({
    timeout_ms: 100, poll_ms: 0,
    take_snapshot: async () => (++attempts === 1 ? { ...fixture, records: [] } : fixture)
  });
  assert.equal(settled.reason, 'profile_ready');
  assert.equal(settled.attempts, 2);
  assert.equal(settled.parsed.profile.legal_name, 'Nutrl, Inc.');
});

test('manual portfolio observations merge by CR ID and finish only on user confirmation', () => {
  const partial = { creative_external_id: 'CR111', creative_url: 'https://adstransparency.google.com/advertiser/AR111/creative/CR111', quality_status: 'partial', image_urls: ['https://cdn.example/one.png'] };
  const complete = { ...partial, quality_status: 'complete', headline: 'Acme offer', display_url: 'acme.example', image_urls: ['https://cdn.example/two.png'] };
  const merged = mergeManualCreativeObservations([partial], [complete, complete]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].quality_status, 'complete');
  assert.equal(merged[0].display_url, 'acme.example');
  assert.deepEqual(merged[0].image_urls, ['https://cdn.example/one.png', 'https://cdn.example/two.png']);
  const collection = manualCreativeCollection({
    creatives: merged, reported_total: 1, observations: 7,
    filter_urls: ['https://adstransparency.google.com/advertiser/AR111?region=anywhere'],
  });
  assert.equal(collection.unique_cards_discovered, 1);
  assert.equal(collection.creatives_with_text, 1);
  assert.equal(collection.truncated, false);
  assert.equal(collection.stop_reason, 'manual_user_confirmed');
  assert.equal(collection.pages_or_batches, 7);
  const imageOnly = manualCreativeCollection({ creatives: [partial], reported_total: 9 });
  assert.equal(imageOnly.truncated, false);
  assert.equal(imageOnly.user_confirmed, true);
  assert.equal(imageOnly.data_quality_incomplete, true);
});

test('maps original creative image URLs from the exact child frame snapshot', () => {
  const profileUrl = 'https://adstransparency.google.com/advertiser/AR111?region=anywhere';
  const frameUrl = 'https://www.google.com/ads/creative-frame?id=1';
  const parsed = parseAdsTransparencySnapshot({ profile_url: profileUrl, records: [{
    creative_id: 'CR111', creative_url: `${profileUrl}/creative/CR111`, iframe_urls: [frameUrl],
    candidate_quality: { atomic: true, unique_creative_ids: 1, iframe_count: 1 }, warnings: [],
  }], frame_snapshots: [{ frame_url: frameUrl, sequence: 1, frame_id: 7,
    headline: 'Image ad', image_count: 1, image_urls: ['https://cdn.example/original.png'] }] });
  assert.deepEqual(parsed.creatives[0].image_urls, ['https://cdn.example/original.png']);
});

test('manual portfolio is not truncated at the former 200 creative ceiling', () => {
  const creatives = Array.from({ length: 350 }, (_, index) => ({
    creative_external_id: `CR${100000 + index}`, quality_status: 'partial',
  }));
  assert.equal(mergeManualCreativeObservations([], creatives).length, 350);
});
