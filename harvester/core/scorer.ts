import type {
  CouponScore,
  DomainValidationOverrides,
  HarvesterCandidate,
  ScoreOptions,
} from "./types.ts";

const TOKEN_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,30}[A-Z0-9]$|^[A-Z0-9]{3}$/;

const BUILTIN_BLOCKLIST = new Set([
  "COPY",
  "COPIED",
  "SHOW",
  "REVEAL",
  "CLICK",
  "HERE",
  "TERMS",
  "DETAILS",
  "SALE",
  "OFF",
  "FREE",
  "DEAL",
  "SUBMIT",
  "VIEW",
  "MORE",
  "NULL",
  "UNDEFINED",
  "TRUE",
  "FALSE",
  "USD",
  "VND",
  "HTTP",
  "HTTPS",
  "WWW",
  "HTML",
  "JSON",
  "GET",
  "POST",
]);

// This starter set catches the most common UI words. A larger dictionary can be
// injected through ScoreOptions without coupling the core to a locale bundle.
export const DEFAULT_COMMON_WORDS: ReadonlySet<string> = new Set([
  "ACCOUNT",
  "APPLY",
  "BACK",
  "BUTTON",
  "CHECKOUT",
  "CLOSE",
  "CODE",
  "COUPON",
  "DISCOUNT",
  "EMAIL",
  "ENTER",
  "LOGIN",
  "NEXT",
  "OFFER",
  "ORDER",
  "PASSWORD",
  "PROMO",
  "REGISTER",
  "SEARCH",
  "SIGNUP",
  "VOUCHER",
]);

function normalizedSet(values?: Iterable<string>): Set<string> {
  return new Set(Array.from(values ?? [], (value) => normalizeCode(value)));
}

export function normalizeCode(rawCode: string): string {
  return rawCode
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`,.;:!?]+$/gu, "")
    .toUpperCase();
}

function looksLikeUrlOrEmail(raw: string): boolean {
  return /(?:https?:\/\/|www\.|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/iu.test(raw);
}

function looksLikeMoney(raw: string): boolean {
  return /(?:[$€£¥₫]\s*\d|\b\d+(?:[.,]\d{1,2})?\s*(?:USD|EUR|GBP|VND)\b)/iu.test(raw);
}

function looksLikeDate(raw: string): boolean {
  return /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/u.test(raw.trim());
}

function looksLikeHexColor(raw: string): boolean {
  return /^#[0-9A-F]{3}(?:[0-9A-F]{3})?$/iu.test(raw.trim());
}

function looksLikeHtmlEntity(raw: string): boolean {
  return /^&(?:#\d+|#x[0-9A-F]+|[A-Z][A-Z0-9]+);$/iu.test(raw.trim());
}

export function validateCode(
  rawCode: string,
  overrides: DomainValidationOverrides = {},
): { valid: boolean; code: string; reason?: string } {
  const code = normalizeCode(rawCode);
  const allowCodes = normalizedSet(overrides.allowCodes);
  const blockCodes = normalizedSet(overrides.blockCodes);

  if (allowCodes.has(code)) return { valid: true, code };
  if (code.length < 3 || code.length > 32) return { valid: false, code, reason: "length" };
  if (looksLikeUrlOrEmail(rawCode)) return { valid: false, code, reason: "url_or_email" };
  if (looksLikeMoney(rawCode)) return { valid: false, code, reason: "money" };
  if (looksLikeDate(rawCode)) return { valid: false, code, reason: "date" };
  if (looksLikeHexColor(rawCode)) return { valid: false, code, reason: "hex_color" };
  if (looksLikeHtmlEntity(rawCode)) return { valid: false, code, reason: "html_entity" };
  if (!TOKEN_PATTERN.test(code)) return { valid: false, code, reason: "characters" };
  if (BUILTIN_BLOCKLIST.has(code) || blockCodes.has(code)) {
    return { valid: false, code, reason: "blocklist" };
  }
  return { valid: true, code };
}

export function scoreCandidate(candidate: HarvesterCandidate, options: ScoreOptions = {}): CouponScore {
  const validation = validateCode(candidate.rawCode, options.domainOverrides);
  if (!validation.valid) {
    return {
      code: validation.code,
      confidence: 0,
      decision: "reject",
      hardValid: false,
      reasons: [`reject:${validation.reason ?? "invalid"}`],
    };
  }

  const code = validation.code;
  const reasons: string[] = [];
  let confidence = 0;
  const add = (points: number, reason: string) => {
    confidence += points;
    reasons.push(`${points > 0 ? "+" : ""}${points}:${reason}`);
  };

  if (candidate.detectedBy.includes("clipboard")) add(50, "clipboard");
  if (candidate.detectedBy.includes("network")) add(40, "network");
  if (candidate.detectedBy.includes("clickdiff")) add(30, "clickdiff");
  if (candidate.style?.semanticClass) add(20, "semantic_style");
  if (candidate.explicitLabel) add(20, "explicit_coupon_label");
  if (candidate.nearKeyword) add(15, "near_keyword");
  if (candidate.rawCode === candidate.rawCode.toUpperCase()) add(10, "uppercase");
  if (/[A-Z]/u.test(code) && /\d/u.test(code)) add(5, "letters_and_numbers");

  const commonWords = options.commonWords ?? DEFAULT_COMMON_WORDS;
  if (commonWords.has(code)) add(-25, "common_word");
  if ((candidate.occurrenceCount ?? 0) > 30) add(-20, "too_frequent");

  confidence = Math.max(0, Math.min(100, confidence));
  if (candidate.detectedBy.includes("ocr")) confidence = Math.min(59, confidence);
  const decision = confidence >= 60 ? "auto_save" : confidence >= 35 ? "review" : "reject";
  return { code, confidence, decision, hardValid: true, reasons };
}
