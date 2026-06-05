import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SourceFeasibilityStatus =
  | "confirmed"
  | "needs_review"
  | "not_found"
  | "blocked"
  | "captcha"
  | "login_required"
  | "unsupported";

export interface SourceFeasibilityResult {
  source: string;
  propertyName: string;
  propertyId?: string;
  sourcePropertyId?: string | null;
  propertyUrl?: string | null;
  status: SourceFeasibilityStatus;
  accessStatus: string;
  notes: string;
  checkedAtJst: string;
  debugJsonPath?: string | null;
  screenshotPath?: string | null;
  safePriceExtracted?: boolean;
  priceTotalTaxIncluded?: number | null;
}

/**
 * Coverage upsert payload derived from a feasibility result. Intentionally
 * omits propertyId — the property is resolved when persisting — and omits
 * any price field, because feasibility probes never apply prices.
 */
export interface PropertySourceCoverageUpsertInput {
  source: string;
  sourcePropertyId: string | null;
  propertyUrl: string | null;
  coverageStatus: SourceFeasibilityStatus;
  accessStatus: string;
  lastVerifiedAt: string;
  notes: string;
  active: boolean;
}

export interface FeasibilityClassification {
  status: SourceFeasibilityStatus;
  accessStatus: string;
  notes: string;
}

// Coverage status mirrors the feasibility status one-to-one; both share the
// same vocabulary defined by the property_source_coverage CHECK constraint.
export function mapFeasibilityToCoverageStatus(result: SourceFeasibilityResult): SourceFeasibilityStatus {
  return result.status;
}

/**
 * Active semantics: a source stays "active" (a usable / re-checkable candidate)
 * only when confirmed or needs_review. blocked / captcha / login_required /
 * unsupported / not_found are recorded as inactive so they are surfaced as
 * gaps rather than treated as usable coverage. This matches the Phase 40X seed
 * (booking blocked = active:false, rakuten/google needs_review = active:true).
 */
const ACTIVE_BY_STATUS: Record<SourceFeasibilityStatus, boolean> = {
  confirmed: true,
  needs_review: true,
  not_found: false,
  blocked: false,
  captcha: false,
  login_required: false,
  unsupported: false
};

export function isActiveForFeasibilityStatus(status: SourceFeasibilityStatus): boolean {
  return ACTIVE_BY_STATUS[status];
}

export function buildCoverageUpdateFromFeasibility(
  result: SourceFeasibilityResult
): PropertySourceCoverageUpsertInput {
  return {
    source: result.source,
    sourcePropertyId: result.sourcePropertyId ?? null,
    propertyUrl: result.propertyUrl ?? null,
    coverageStatus: mapFeasibilityToCoverageStatus(result),
    accessStatus: result.accessStatus,
    lastVerifiedAt: result.checkedAtJst,
    notes: result.notes,
    active: isActiveForFeasibilityStatus(result.status)
  };
}

export function buildSourceFeasibilityResult(params: {
  source: string;
  propertyName: string;
  sourcePropertyId?: string | null;
  propertyUrl?: string | null;
  classification: FeasibilityClassification;
  checkedAtJst: string;
  propertyId?: string;
  debugJsonPath?: string | null;
  screenshotPath?: string | null;
}): SourceFeasibilityResult {
  return {
    source: params.source,
    propertyName: params.propertyName,
    ...(params.propertyId !== undefined ? { propertyId: params.propertyId } : {}),
    sourcePropertyId: params.sourcePropertyId ?? null,
    propertyUrl: params.propertyUrl ?? null,
    status: params.classification.status,
    accessStatus: params.classification.accessStatus,
    notes: params.classification.notes,
    checkedAtJst: params.checkedAtJst,
    debugJsonPath: params.debugJsonPath ?? null,
    screenshotPath: params.screenshotPath ?? null,
    safePriceExtracted: false,
    priceTotalTaxIncluded: null
  };
}

export async function writeFeasibilityDebugArtifact(
  result: SourceFeasibilityResult,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const dir = join(".data/debug/feasibility", result.source);
  await mkdir(dir, { recursive: true });
  const stamp = result.checkedAtJst.replace("T", "_").replace(/[-:+]/g, "").slice(0, 15);
  const path = join(dir, `${stamp}.json`);
  await writeFile(path, JSON.stringify({ ...result, ...extra }, null, 2), "utf8");
  return path;
}
