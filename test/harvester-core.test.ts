import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { dedupeCoupons, toCoupon } from "../harvester/core/dedup.ts";
import { scoreCandidate, validateCode } from "../harvester/core/scorer.ts";
import { extractTextCandidates, extractUrlCandidates } from "../harvester/core/text-extractor.ts";
import type { HarvesterCandidate } from "../harvester/core/types.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

test("extracts the two visible ASPHostPortal promo codes", () => {
  const candidates = extractTextCandidates(
    fixture("asphostportal-headings.html"),
    "https://asphostportal.com/Hosting-Promotions",
    100,
  );
  assert.deepEqual(candidates.map((candidate) => candidate.rawCode.toUpperCase()).sort(), ["DBSQL", "FREEDOMAIN"]);
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate);
    assert.notEqual(score.decision, "reject", `${score.code}: ${score.reasons.join(", ")}`);
  }
});

test("extracts code before a multilingual coupon label", () => {
  const candidates = extractTextCandidates(
    "<p>WELCOME20 là mã giảm giá dành cho khách hàng mới.</p>",
    "https://merchant.example/offers",
    200,
  );
  assert.equal(candidates[0]?.rawCode, "WELCOME20");
  assert.equal(scoreCandidate(candidates[0]).decision, "review");
});

test("reads relevant data attributes and readonly input values", () => {
  const html = '<button data-coupon-code="SAVE25">Reveal</button><input readonly value="HELLO15">';
  const candidates = extractTextCandidates(html, "https://merchant.example/coupons", 300);
  assert.deepEqual(candidates.map((candidate) => candidate.rawCode).sort(), ["HELLO15", "SAVE25"]);
});

test("extracts coupon parameters from query and hash", () => {
  const query = extractUrlCandidates("https://merchant.example/deal?utm=x&promo_code=SAVE30", 400);
  const hash = extractUrlCandidates("https://merchant.example/#coupon=HELLO10", 400);
  assert.equal(query[0]?.rawCode, "SAVE30");
  assert.equal(hash[0]?.rawCode, "HELLO10");
});

test("clipboard evidence crosses the automatic-save threshold", () => {
  const candidate: HarvesterCandidate = {
    rawCode: "WELCOME20",
    sourceUrl: "https://merchant.example/",
    hostname: "merchant.example",
    detectedBy: ["clipboard"],
    nearKeyword: true,
    firstSeen: 10,
    lastSeen: 10,
  };
  const score = scoreCandidate(candidate);
  assert.equal(score.decision, "auto_save");
  assert.ok(score.confidence >= 60);
});

test("rejects UI words, prices, dates, colors, URLs and email addresses", () => {
  const values = ["COPY", "$4.49", "2026-08-12", "#AABBCC", "https://example.com", "promo@example.com"];
  for (const value of values) assert.equal(validateCode(value).valid, false, value);

  const candidates = extractTextCandidates(
    fixture("false-positive-trap.html"),
    "https://merchant.example/deals",
    500,
  );
  assert.equal(candidates.filter((candidate) => scoreCandidate(candidate).decision !== "reject").length, 0);
});

test("domain allowlist and blocklist override global validation", () => {
  assert.equal(validateCode("FREE").valid, false);
  assert.equal(validateCode("FREE", { allowCodes: ["free"] }).valid, true);
  assert.equal(validateCode("MERCHANT20", { blockCodes: ["merchant20"] }).valid, false);
});

test("deduplication merges evidence and keeps the strongest metadata", () => {
  const base: HarvesterCandidate = {
    rawCode: "SAVE20",
    sourceUrl: "https://merchant.example/a",
    hostname: "merchant.example",
    context: "Save 20%",
    detectedBy: ["text"],
    explicitLabel: true,
    nearKeyword: true,
    firstSeen: 10,
    lastSeen: 10,
  };
  const stronger: HarvesterCandidate = {
    ...base,
    sourceUrl: "https://merchant.example/b",
    context: "Save 20% on every annual hosting plan",
    detectedBy: ["network"],
    firstSeen: 20,
    lastSeen: 30,
    verified: true,
  };
  const coupons = dedupeCoupons([
    toCoupon(base, scoreCandidate(base)),
    toCoupon(stronger, scoreCandidate(stronger)),
  ]);
  assert.equal(coupons.length, 1);
  assert.deepEqual(coupons[0].detectedBy.sort(), ["network", "text"]);
  assert.equal(coupons[0].firstSeen, 10);
  assert.equal(coupons[0].lastSeen, 30);
  assert.equal(coupons[0].verified, true);
  assert.match(coupons[0].description, /annual hosting plan/u);
});
