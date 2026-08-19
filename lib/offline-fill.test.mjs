import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OFFLINE_ANSWERS_CAP, buildOfflinePlan, detectFieldKey, harvestAnswers,
  mergeAnswers, normalizeLabel,
} from './offline-fill.mjs';

const scanField = (over = {}) => ({
  dom_id: 'haf_0_0', tag: 'input', type: 'text', name: '', label: '', placeholder: '',
  aria_label: '', required: false, maxlength: null, options: [], unsafe: false, ...over,
});

test('normalizeLabel gộp khoảng trắng, bỏ dấu câu, giữ chữ có dấu', () => {
  assert.equal(normalizeLabel('  Your   E-mail: *'), 'your e mail');
  assert.equal(normalizeLabel('Công ty (bắt buộc)'), 'công ty bắt buộc');
});

test('detectFieldKey ưu tiên type rồi tới alias, company thắng full_name', () => {
  assert.equal(detectFieldKey(scanField({ type: 'email' })), 'email');
  assert.equal(detectFieldKey(scanField({ type: 'tel' })), 'phone');
  assert.equal(detectFieldKey(scanField({ label: 'Company Name' })), 'company');
  assert.equal(detectFieldKey(scanField({ label: 'Your Name' })), 'full_name');
  assert.equal(detectFieldKey(scanField({ label: 'Website URL' })), 'website');
  assert.equal(detectFieldKey(scanField({ label: 'Mã số bí mật gì đó' })), null);
});

test('harvestAnswers chỉ học giá trị an toàn có thật', () => {
  const scan = { fields: [
    scanField({ dom_id: 'a', label: 'Email address' }),
    scanField({ dom_id: 'b', label: 'Password', unsafe: true }),
    scanField({ dom_id: 'c', label: 'Agree to terms', type: 'checkbox' }),
    scanField({ dom_id: 'd', label: 'Website' }),
  ] };
  const plan = { fields: [
    { dom_id: 'a', field_key: 'email', value: 'x@y.com' },
    { dom_id: 'b', field_key: 'local_password', value: 'S3cret!', locally_managed_secret: true },
    { dom_id: 'c', field_key: 'terms', value: 'true' },
    { dom_id: 'd', field_key: 'website', value: 'https://y.com' },
    { dom_id: 'e', field_key: 'tax_id', value: '123', sensitive: true },
    { dom_id: 'f', field_key: 'empty', value: '   ' },
  ] };
  const entries = harvestAnswers(plan, scan, 1000);
  assert.deepEqual(entries.map((e) => e.field_key), ['email', 'website']);
  assert.equal(entries[0].label, 'email address');
  assert.equal(entries[0].updated_at, 1000);
});

test('mergeAnswers: mới đè cũ theo field_key, sắp mới trước, có trần', () => {
  const merged = mergeAnswers(
    [{ field_key: 'email', label: 'email', value: 'old@x.com', updated_at: 1 }],
    [{ field_key: 'email', label: 'e mail', value: 'new@x.com', updated_at: 2 },
     { field_key: null, label: 'chỗ ở', value: 'HN', updated_at: 3 }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].value, 'HN');
  assert.equal(merged[1].value, 'new@x.com');
  const many = mergeAnswers([], Array.from({ length: 400 }, (_, i) => (
    { field_key: `k${i}`, label: `l${i}`, value: 'v', updated_at: i })));
  assert.equal(many.length, OFFLINE_ANSWERS_CAP);
  assert.equal(many[0].field_key, 'k399');
});

test('buildOfflinePlan khớp theo nhãn chính xác trước, alias sau', () => {
  const answers = [
    { field_key: 'email', label: 'email address', value: 'x@y.com', updated_at: 2 },
    { field_key: null, label: 'how did you hear about us', value: 'Google', updated_at: 1 },
  ];
  const scan = { fields: [
    scanField({ dom_id: 'a', label: 'How did you hear about us?' }),
    scanField({ dom_id: 'b', label: 'Your e-mail', type: 'email' }),
    scanField({ dom_id: 'c', label: 'Trường lạ hoắc' }),
  ], submit_present: true };
  const plan = buildOfflinePlan(scan, answers);
  assert.equal(plan.offline, true);
  assert.equal(plan.fields.length, 2);
  assert.deepEqual(plan.fields.find((f) => f.dom_id === 'a').value, 'Google');
  assert.deepEqual(plan.fields.find((f) => f.dom_id === 'b').value, 'x@y.com');
  assert.deepEqual(plan.unmatched_labels, ['trường lạ hoắc']);
});

test('buildOfflinePlan không đụng trường unsafe/checkbox, select phải khớp option', () => {
  const answers = [
    { field_key: 'country', label: 'country', value: 'Vietnam', updated_at: 1 },
    { field_key: 'email', label: 'email', value: 'x@y.com', updated_at: 1 },
  ];
  const scan = { fields: [
    scanField({ dom_id: 'pw', label: 'Password', unsafe: true }),
    scanField({ dom_id: 'tick', label: 'Country', type: 'checkbox' }),
    scanField({ dom_id: 'sel', tag: 'select', label: 'Country',
      options: [{ value: 'VN', label: 'Vietnam', disabled: false }] }),
    scanField({ dom_id: 'sel2', tag: 'select', label: 'Country',
      options: [{ value: 'US', label: 'United States', disabled: false }] }),
    scanField({ dom_id: 'em', label: 'Email', maxlength: 3 }),
  ] };
  const plan = buildOfflinePlan(scan, answers);
  assert.equal(plan.fields.length, 1);
  assert.deepEqual(plan.fields[0], { dom_id: 'sel', field_key: 'country', value: 'VN' });
});
