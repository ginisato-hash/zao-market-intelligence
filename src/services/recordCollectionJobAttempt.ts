import type { CollectionJobAttempt, CollectionJobAttemptOutcome, CollectorInput, CollectorResult } from "../domain/types";
import { createId } from "../utils/ids";

const BLOCKED_REASON_PATTERN = /blocked|captcha|access.*denied|bot/i;

function resolveOutcome(result: CollectorResult): CollectionJobAttemptOutcome {
  const status = result.rateSnapshot.availabilityStatus;
  const errorReason = result.rateSnapshot.errorReason ?? "";

  if (status === "failed" && BLOCKED_REASON_PATTERN.test(errorReason)) {
    return "blocked";
  }
  if (status === "failed") {
    return "failed";
  }
  // available / sold_out / not_listed / not_found
  return "success";
}

export interface BuildCollectionJobAttemptOptions {
  debugJsonPath?: string;
  retryCount?: number;
}

export function buildCollectionJobAttempt(
  input: CollectorInput,
  result: CollectorResult,
  opts: BuildCollectionJobAttemptOptions = {}
): CollectionJobAttempt {
  const outcome = resolveOutcome(result);
  const status = result.rateSnapshot.availabilityStatus;

  // Only carry forward the price for confirmed available snapshots.
  const priceTotalTaxIncluded =
    status === "available" && result.rateSnapshot.priceTotalTaxIncluded !== null
      ? result.rateSnapshot.priceTotalTaxIncluded
      : null;

  return {
    id: createId("attempt"),
    jobId: input.jobId ?? `job_${input.propertyId}_${input.ota}_${input.stayDate}`,
    runId: result.rateSnapshot.runId,
    propertyId: result.rateSnapshot.propertyId,
    ota: result.rateSnapshot.ota,
    stayDate: result.rateSnapshot.stayDate,
    guests: result.rateSnapshot.guests,
    nights: result.rateSnapshot.nights,
    attemptedAtJst: result.rateSnapshot.checkedAtJst,
    outcome,
    availabilityStatus: status,
    priceTotalTaxIncluded,
    errorReason: result.rateSnapshot.errorReason ?? null,
    screenshotPath: result.rateSnapshot.screenshotKey ?? null,
    debugJsonPath: opts.debugJsonPath ?? null,
    retryCount: opts.retryCount ?? 0
  };
}
