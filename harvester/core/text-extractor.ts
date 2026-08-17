import type { DetectionMethod, HarvesterCandidate } from "./types.ts";

const CODE_TOKEN_SOURCE = `[A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9]`;
const QUOTED_CODE_SOURCE = `["'“”‘’\\x60]?(${CODE_TOKEN_SOURCE})["'“”‘’\\x60]?`;
const LABEL_SOURCE = [
  `\\b(?:promo(?:tional)?|coupon|voucher|discount|offer)\\s+code\\b`,
  `\\b(?:use|apply|enter)\\s+(?:the\\s+)?(?:(?:promo(?:tional)?|coupon|voucher|discount)\\s+)?code\\b`,
  `(?<![\\p{L}\\p{N}_])mã\\s+(?:giảm\\s+giá|khuyến\\s+mãi|ưu\\s+đãi)(?![\\p{L}\\p{N}_])`,
  `\\b(?:kortings|rabatt)code\\b`,
].join("|");

const AFTER_LABEL = new RegExp(
  `(?:${LABEL_SOURCE})\\s*(?:is|là|as)?\\s*[:=\\-–—]?\\s*${QUOTED_CODE_SOURCE}`,
  "giu",
);
const BEFORE_LABEL = new RegExp(
  `${QUOTED_CODE_SOURCE}\\s*(?:is|là|as)?\\s*(?:a|the)?\\s*(?:${LABEL_SOURCE})`,
  "giu",
);
const RELEVANT_DATA_ATTRIBUTE = /^(?:data-)?(?:coupon|promo|voucher|discount|offer|code)(?:[-_:].*)?$/iu;
const GENERIC_ATTRIBUTE = /^(?:alt|title|aria-label|placeholder)$/iu;
const VALUE_ATTRIBUTE = /^value$/iu;

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#(\d+);/gu, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/giu, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&([a-z]+);/giu, (entity, name: string) => named[name.toLowerCase()] ?? entity);
}

function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)>/giu, " ")
      .replace(/<!--([\s\S]*?)-->/gu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

function attributesFromTag(tagSource: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu;
  for (const match of tagSource.matchAll(attributePattern)) {
    attributes.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

function extractRelevantTextBlocks(html: string): Array<{
  text: string;
  title?: string;
  semanticClass?: boolean;
  directCandidate?: boolean;
}> {
  const blocks: Array<{
    text: string;
    title?: string;
    semanticClass?: boolean;
    directCandidate?: boolean;
  }> = [];
  const cleanHtml = html.replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)>/giu, " ");
  const blockPattern = /<(h[1-6]|p|li|td|th|button|label|div|span)\b([^>]*)>([\s\S]*?)<\/\1>/giu;
  for (const match of cleanHtml.matchAll(blockPattern)) {
    const text = plainText(match[3]);
    if (!text) continue;
    const tag = match[1].toLowerCase();
    const attributes = attributesFromTag(match[2]);
    const classAndId = `${attributes.get("class") ?? ""} ${attributes.get("id") ?? ""}`;
    blocks.push({
      text,
      title: tag.startsWith("h") ? text.slice(0, 180) : undefined,
      semanticClass: /coupon|promo|voucher|discount|code/iu.test(classAndId),
    });
  }

  const tagPattern = /<([a-z][\w:-]*)\b([^>]*)>/giu;
  for (const tagMatch of cleanHtml.matchAll(tagPattern)) {
    const attributes = attributesFromTag(tagMatch[2]);
    const readonlyValue = /(?:^|\s)(?:readonly|disabled)(?:\s|=|$)/iu.test(tagMatch[2]);
    for (const [name, value] of attributes) {
      if (!value) continue;
      const relevant = RELEVANT_DATA_ATTRIBUTE.test(name) || GENERIC_ATTRIBUTE.test(name) || (VALUE_ATTRIBUTE.test(name) && readonlyValue);
      if (relevant) {
        const directCandidate = RELEVANT_DATA_ATTRIBUTE.test(name) || (VALUE_ATTRIBUTE.test(name) && readonlyValue);
        blocks.push({
          text: value,
          semanticClass: directCandidate,
          directCandidate,
        });
      }
    }
  }
  return blocks;
}

function candidateFromMatch(
  rawCode: string,
  context: string,
  sourceUrl: string,
  method: DetectionMethod,
  now: number,
  title?: string,
  semanticClass?: boolean,
): HarvesterCandidate | null {
  let hostname: string;
  try {
    hostname = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return {
    rawCode,
    sourceUrl,
    hostname,
    context: context.slice(0, 300),
    offerTitle: title,
    detectedBy: [method],
    firstSeen: now,
    lastSeen: now,
    explicitLabel: method === "text",
    nearKeyword: method === "text",
    style: { semanticClass: Boolean(semanticClass) },
  };
}

function collectMatches(
  text: string,
  pattern: RegExp,
  sourceUrl: string,
  now: number,
  title?: string,
  semanticClass?: boolean,
  codeComesBeforeLabel = false,
): HarvesterCandidate[] {
  const found: HarvesterCandidate[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (
      codeComesBeforeLabel &&
      !/[0-9_-]/u.test(match[1]) &&
      match[1] !== match[1].toUpperCase()
    ) {
      continue;
    }
    const candidate = candidateFromMatch(match[1], text, sourceUrl, "text", now, title, semanticClass);
    if (candidate) found.push(candidate);
  }
  return found;
}

function countOccurrences(corpus: string, code: string): number {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return Array.from(corpus.matchAll(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "giu"))).length;
}

export function extractTextCandidates(html: string, sourceUrl: string, now = Date.now()): HarvesterCandidate[] {
  const blocks = extractRelevantTextBlocks(html);
  const pageText = plainText(html);
  const corpus = `${pageText} ${blocks.map((block) => block.text).join(" ")}`;
  const candidates: HarvesterCandidate[] = [];
  for (const block of blocks) {
    if (block.directCandidate) {
      const direct = candidateFromMatch(
        block.text,
        block.text,
        sourceUrl,
        "text",
        now,
        block.title,
        block.semanticClass,
      );
      if (direct) candidates.push(direct);
    }
    candidates.push(...collectMatches(block.text, AFTER_LABEL, sourceUrl, now, block.title, block.semanticClass));
    candidates.push(...collectMatches(block.text, BEFORE_LABEL, sourceUrl, now, block.title, block.semanticClass, true));
  }

  const unique = new Map<string, HarvesterCandidate>();
  for (const candidate of candidates) {
    const key = candidate.rawCode.toUpperCase();
    const existing = unique.get(key);
    candidate.occurrenceCount = countOccurrences(corpus, candidate.rawCode);
    if (!existing) {
      unique.set(key, candidate);
      continue;
    }
    existing.occurrenceCount = Math.max(existing.occurrenceCount ?? 0, candidate.occurrenceCount);
    existing.style = {
      ...existing.style,
      semanticClass: existing.style?.semanticClass || candidate.style?.semanticClass,
    };
    if (!existing.offerTitle && candidate.offerTitle) existing.offerTitle = candidate.offerTitle;
  }
  return [...unique.values()];
}

export function extractUrlCandidates(sourceUrl: string, now = Date.now()): HarvesterCandidate[] {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return [];
  }
  const keyPattern = /(?:^|[-_])(coupon|promo|voucher|discount|offer|code)(?:$|[-_])/iu;
  const values: Array<{ key: string; value: string }> = [];
  for (const [key, value] of url.searchParams) {
    if (keyPattern.test(key) && value) values.push({ key, value });
  }
  const hash = url.hash.replace(/^#/, "");
  if (hash) {
    const hashParams = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash);
    for (const [key, value] of hashParams) {
      if (keyPattern.test(key) && value) values.push({ key, value });
    }
  }
  return values.flatMap(({ key, value }) => {
    const candidate = candidateFromMatch(value, `${key}=${value}`, sourceUrl, "url", now);
    if (!candidate) return [];
    candidate.explicitLabel = true;
    candidate.nearKeyword = true;
    return [candidate];
  });
}
