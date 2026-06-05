import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JalanExtractionEvidence } from "./jalanEvidence";
import type { JalanCandidateDiagnostics } from "./jalanLinkInspector";
import type { JalanPlanBlockDebugSummary } from "./jalanPlanBlockExtractor";
import type { JalanAcceptedPricePolicy } from "./jalanAcceptedPricePolicy";

export interface JalanAcceptedPricePolicyDebug {
  policy: JalanAcceptedPricePolicy;
  safeCandidateCount: number;
  rejectedCandidateCount: number;
  selectedIndex?: number;
  selectedPrice?: number;
  selectedPriceText?: string;
  selectedPlanName?: string;
  selectedRoomName?: string;
  reason: string;
}

export interface JalanDebugArtifactInput {
  runId: string;
  debugFileName?: string;
  propertyName: string;
  propertyUrl: string;
  stayDate: string;
  status: string;
  priceJpy: number | null;
  evidence: JalanExtractionEvidence;
  errorReason?: string | null;
  screenshotPath?: string;
  selectedExcerpts: string[];
  navigation?: {
    attempted: boolean;
    strategy: string;
    success: boolean;
    beforeUrl: string;
    afterUrl?: string;
    beforeScreenshotPath?: string;
    afterScreenshotPath?: string;
    errorReason?: string;
    candidateDiagnostics?: JalanCandidateDiagnostics;
  };
  // Candidate diagnostics only. The authoritative representative persisted price is acceptedPricePolicy.
  planBlockExtraction?: JalanPlanBlockDebugSummary;
  acceptedPricePolicy?: JalanAcceptedPricePolicyDebug;
}

export async function writeJalanDebugArtifact(input: JalanDebugArtifactInput): Promise<string> {
  const fileName = input.debugFileName ?? input.stayDate;
  const path = join(".data/debug/jalan", input.runId, `${fileName}.json`);
  await mkdir(join(".data/debug/jalan", input.runId), { recursive: true });
  await writeFile(path, JSON.stringify(input, null, 2), "utf8");
  return path;
}
