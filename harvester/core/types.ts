export type DetectionMethod =
  | "text"
  | "clipboard"
  | "network"
  | "clickdiff"
  | "canvas"
  | "url"
  | "ocr"
  | "rule";

export type CouponDecision = "auto_save" | "review" | "reject";

export interface CandidateStyleSignals {
  monospace?: boolean;
  dashedBorder?: boolean;
  highlighted?: boolean;
  semanticClass?: boolean;
}

export interface HarvesterCandidate {
  rawCode: string;
  sourceUrl: string;
  hostname: string;
  context?: string;
  offerTitle?: string;
  description?: string;
  conditions?: string;
  expiresAt?: string | null;
  detectedBy: DetectionMethod[];
  firstSeen: number;
  lastSeen: number;
  occurrenceCount?: number;
  explicitLabel?: boolean;
  nearKeyword?: boolean;
  style?: CandidateStyleSignals;
  verified?: boolean;
  screenshotCrop?: string;
}

export interface CouponScore {
  code: string;
  confidence: number;
  decision: CouponDecision;
  hardValid: boolean;
  reasons: string[];
}

export interface DomainValidationOverrides {
  allowCodes?: Iterable<string>;
  blockCodes?: Iterable<string>;
}

export interface ScoreOptions {
  commonWords?: ReadonlySet<string>;
  domainOverrides?: DomainValidationOverrides;
}

export interface Coupon {
  id: string;
  code: string;
  offerTitle: string;
  description: string;
  conditions: string;
  expiresAt: string | null;
  sourceUrl: string;
  hostname: string;
  detectedBy: DetectionMethod[];
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  verified: boolean;
  screenshotCrop?: string;
}
