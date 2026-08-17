import assert from 'node:assert/strict';
import test from 'node:test';
import { markManualOverride, preservationReason } from './form-assistant.mjs';

function fakeControl({ value = '', filled = false, name = 'company_name' } = {}) {
  return {
    value,
    type: 'text',
    name,
    id: name.replaceAll('_', '-'),
    dataset: filled ? { hiAutoFilled: 'true' } : {},
    style: { outline: '1px solid blue' },
    getAttribute: () => '',
    matches: (selector) => selector === 'input,textarea,select',
  };
}

test('a real user edit takes ownership and restores the site outline', () => {
  const element = fakeControl({ value: 'Typed by user', filled: true });
  element.dataset.hiAutoPreviousOutline = '1px solid blue';
  element.style.outline = '2px solid #2f9e67';

  assert.equal(markManualOverride(element), true);
  assert.equal(element.dataset.hiAutoManualOverride, 'true');
  assert.equal(element.dataset.hiAutoFilled, undefined);
  assert.equal(element.style.outline, '1px solid blue');
  assert.equal(preservationReason(element), 'manual_override');
});

test('background autofill preserves pre-existing site or browser values', () => {
  const element = fakeControl({ value: 'Existing value', name: 'address_line_1' });
  assert.equal(preservationReason(element), 'existing_value');
  assert.equal(preservationReason(element, { overwrite_existing: true }), '');
});

test('explicit panel correction may replace a manually edited value', () => {
  const element = fakeControl({ value: 'Wrong value', filled: true });
  markManualOverride(element);
  assert.equal(preservationReason(element, { overwrite_manual: true, overwrite_existing: true }), '');
});
