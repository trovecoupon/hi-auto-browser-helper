// Điền form OFFLINE — hoạt động không cần Hi Auto tool lẫn Local Agent.
//
// Nguyên lý: mỗi lần backend lập plan điền form (online), Helper HỌC LÉN các cặp
// (nhãn trường → giá trị) không nhạy cảm vào chrome.storage.local. Khi tool tắt,
// panel vẫn có nút "Điền form ở tab đang mở": quét form tại chỗ rồi ráp plan từ
// kho đã học. KHÔNG đụng mật khẩu/checkbox điều khoản/CAPTCHA/Submit — mấy thứ đó
// luôn thuộc về người dùng hoặc luồng online đầy đủ.
//
// File này THUẦN (không chrome.*) để test được bằng node --test.

export const OFFLINE_ANSWERS_KEY = 'offline_fill_answers_v1';
export const OFFLINE_ANSWERS_CAP = 300;

/** Nhãn so khớp: thường, bỏ dấu câu, gộp khoảng trắng. Giữ nguyên chữ có dấu
 *  tiếng Việt — hai form cùng ngôn ngữ thì nhãn giống nhau là đủ. */
export function normalizeLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Thứ tự CÓ Ý NGHĨA: mẫu hẹp đứng trước mẫu rộng (company trước full_name,
// vì "company name" cũng chứa chữ "name").
const FIELD_ALIASES = [
  ['email', /\be-?mail\b/],
  ['website', /\b(?:web\s?site|site\s?url|homepage|your\s?url|domain|trang\s?web)\b/],
  ['company', /\b(?:company|business\s?name|organi[sz]ation|công\s?ty)\b/],
  ['first_name', /\b(?:first\s?name|given\s?name|fname)\b/],
  ['last_name', /\b(?:last\s?name|surname|family\s?name|lname)\b/],
  ['phone', /\b(?:phone|mobile|telephone|tel|điện\s?thoại)\b/],
  ['address', /\b(?:street|address\s?line|address|địa\s?chỉ)\b/],
  ['city', /\b(?:city|town|thành\s?phố)\b/],
  ['state', /\b(?:state|province|region|tỉnh)\b/],
  ['postal_code', /\b(?:zip|postal|post\s?code)\b/],
  ['country', /\b(?:country|quốc\s?gia)\b/],
  ['full_name', /\b(?:full\s?name|your\s?name|contact\s?name|name|họ\s?tên)\b/],
];

/** Đoán field_key chuẩn từ một trường trong scan (name/label/placeholder/type). */
export function detectFieldKey(field) {
  const type = String(field?.type || '').toLowerCase();
  if (type === 'email') return 'email';
  if (type === 'tel') return 'phone';
  if (type === 'url') return 'website';
  const haystack = normalizeLabel(
    `${field?.name || ''} ${field?.label || ''} ${field?.placeholder || ''} ${field?.aria_label || ''}`,
  );
  if (!haystack) return null;
  for (const [key, pattern] of FIELD_ALIASES) {
    if (pattern.test(haystack)) return key;
  }
  return null;
}

/** Học từ một plan online: trả về entries {field_key, label, value, updated_at}.
 *  Chỉ giá trị KHÔNG nhạy cảm (bỏ mật khẩu cục bộ, trường sensitive, trường unsafe). */
export function harvestAnswers(plan, scan, now = Date.now()) {
  const scanByDomId = new Map((scan?.fields || []).map((field) => [field.dom_id, field]));
  const entries = [];
  for (const item of plan?.fields || []) {
    if (!item || item.sensitive || item.confirmed_sensitive || item.locally_managed_secret) continue;
    const value = String(item.value ?? '').trim();
    if (!value || value.length > 500) continue;
    const scanned = scanByDomId.get(item.dom_id);
    if (scanned?.unsafe) continue;
    if (['checkbox', 'radio'].includes(String(scanned?.type || '').toLowerCase())) continue;
    const label = normalizeLabel(scanned?.label || scanned?.placeholder || scanned?.name || '');
    const fieldKey = String(item.field_key || '').trim() || null;
    if (!fieldKey && !label) continue;
    entries.push({ field_key: fieldKey, label, value, updated_at: now });
  }
  return entries;
}

/** Gộp entries mới vào kho: mới đè cũ theo (field_key trước, không có thì nhãn),
 *  sắp mới-nhất-trước, cắt trần để storage không phình. */
export function mergeAnswers(existing, entries, cap = OFFLINE_ANSWERS_CAP) {
  const byKey = new Map();
  const keyOf = (entry) => (entry.field_key ? `k:${entry.field_key}` : `l:${entry.label}`);
  for (const entry of [...(existing || []), ...(entries || [])]) {
    if (!entry || (!entry.field_key && !entry.label)) continue;
    const key = keyOf(entry);
    const current = byKey.get(key);
    if (!current || Number(entry.updated_at || 0) >= Number(current.updated_at || 0)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .slice(0, cap);
}

/** Ráp plan điền từ scan tại chỗ + kho đã học. Chỉ trường an toàn; select phải
 *  khớp đúng option; tôn trọng maxlength. Trả plan theo đúng schema applyPlan. */
export function buildOfflinePlan(scan, answers) {
  const byFieldKey = new Map();
  const byLabel = new Map();
  for (const answer of answers || []) {
    // answers đã sắp mới-nhất-trước nên bản đầu tiên thắng.
    if (answer.field_key && !byFieldKey.has(answer.field_key)) byFieldKey.set(answer.field_key, answer);
    if (answer.label && !byLabel.has(answer.label)) byLabel.set(answer.label, answer);
  }
  const fields = [];
  const unmatched = [];
  for (const field of scan?.fields || []) {
    if (!field || field.unsafe) continue;
    const type = String(field.type || '').toLowerCase();
    if (['checkbox', 'radio'].includes(type)) continue;
    const label = normalizeLabel(field.label || field.placeholder || field.aria_label || field.name || '');
    let answer = label ? byLabel.get(label) : null;
    let fieldKey = answer?.field_key || null;
    if (!answer) {
      fieldKey = detectFieldKey(field);
      if (fieldKey) answer = byFieldKey.get(fieldKey);
    }
    if (!answer) {
      if (label) unmatched.push(label);
      continue;
    }
    let value = String(answer.value);
    if (String(field.tag || '').toLowerCase() === 'select') {
      const wanted = value.toLowerCase();
      const option = (field.options || []).find((item) => !item.disabled
        && (String(item.value || '').toLowerCase() === wanted
          || String(item.label || '').trim().toLowerCase() === wanted));
      if (!option) { unmatched.push(label || fieldKey || ''); continue; }
      value = option.value;
    }
    if (Number(field.maxlength) > 0 && value.length > Number(field.maxlength)) continue;
    fields.push({
      dom_id: field.dom_id,
      field_key: fieldKey || `offline_${label.slice(0, 40).replace(/\s+/g, '_')}`,
      value,
    });
  }
  return {
    offline: true,
    fields,
    missing: [],
    blocked: [],
    surface: scan?.surface || 'page',
    submit_present: Boolean(scan?.submit_present),
    unmatched_labels: unmatched.filter(Boolean).slice(0, 40),
  };
}
