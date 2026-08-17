import type { Coupon, DetectionMethod, HarvesterCandidate } from "./types.ts";
import type { CouponScore } from "./types.ts";

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function uniqueMethods(...groups: DetectionMethod[][]): DetectionMethod[] {
  return [...new Set(groups.flat())];
}

export function couponId(hostname: string, code: string): string {
  return `coupon_${stableHash(`${hostname.toLowerCase()}\u0000${code.toUpperCase()}`)}`;
}

export function toCoupon(candidate: HarvesterCandidate, score: CouponScore): Coupon {
  return {
    id: couponId(candidate.hostname, score.code),
    code: score.code,
    offerTitle: candidate.offerTitle ?? "",
    description: candidate.description ?? candidate.context ?? "",
    conditions: candidate.conditions ?? "",
    expiresAt: candidate.expiresAt ?? null,
    sourceUrl: candidate.sourceUrl,
    hostname: candidate.hostname,
    detectedBy: [...new Set(candidate.detectedBy)],
    confidence: score.confidence,
    firstSeen: candidate.firstSeen,
    lastSeen: candidate.lastSeen,
    verified: Boolean(candidate.verified),
    ...(candidate.screenshotCrop ? { screenshotCrop: candidate.screenshotCrop } : {}),
  };
}

function richerText(current: string, incoming: string): string {
  return incoming.length > current.length ? incoming : current;
}

export function mergeCoupon(current: Coupon, incoming: Coupon): Coupon {
  if (current.hostname.toLowerCase() !== incoming.hostname.toLowerCase() || current.code !== incoming.code) {
    throw new Error("Cannot merge coupons with different hostname or code");
  }
  return {
    ...current,
    offerTitle: richerText(current.offerTitle, incoming.offerTitle),
    description: richerText(current.description, incoming.description),
    conditions: richerText(current.conditions, incoming.conditions),
    expiresAt: current.expiresAt ?? incoming.expiresAt,
    sourceUrl: incoming.confidence > current.confidence ? incoming.sourceUrl : current.sourceUrl,
    detectedBy: uniqueMethods(current.detectedBy, incoming.detectedBy),
    confidence: Math.max(current.confidence, incoming.confidence),
    firstSeen: Math.min(current.firstSeen, incoming.firstSeen),
    lastSeen: Math.max(current.lastSeen, incoming.lastSeen),
    verified: current.verified || incoming.verified,
    screenshotCrop: current.screenshotCrop ?? incoming.screenshotCrop,
  };
}

export function dedupeCoupons(coupons: Coupon[]): Coupon[] {
  const result = new Map<string, Coupon>();
  for (const coupon of coupons) {
    const key = `${coupon.hostname.toLowerCase()}\u0000${coupon.code}`;
    const existing = result.get(key);
    result.set(key, existing ? mergeCoupon(existing, coupon) : coupon);
  }
  return [...result.values()];
}
