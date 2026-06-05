import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import { promoteEligibleCandidates } from "../services/promoteSourceCoverageCandidates";

const db = openLocalDatabase();
try {
  executeMigration(db);
  const summary = promoteEligibleCandidates(db);

  console.log(`total_candidates=${summary.totalCandidates}`);
  console.log(`promoted_confirmed=${summary.promotedConfirmed}`);
  console.log(`promoted_needs_review=${summary.promotedNeedsReview}`);
  console.log(`skipped_candidate=${summary.skippedCandidate}`);
  console.log(`skipped_rejected=${summary.skippedRejected}`);
  console.log(`skipped_missing_url_or_id=${summary.skippedMissingUrlOrId}`);
  console.log(`skipped_invalid_source=${summary.skippedInvalidSource}`);
  console.log(`skipped_missing_evidence=${summary.skippedMissingEvidence}`);
  console.log(`count_by_source=${JSON.stringify(summary.countBySource)}`);
  console.log(`count_by_decision=${JSON.stringify(summary.countByDecision)}`);

  if (summary.promotedConfirmed + summary.promotedNeedsReview > 0) {
    console.log("---");
    for (const r of summary.results) {
      if (r.decision === "promoted_confirmed" || r.decision === "promoted_needs_review") {
        console.log(`  promoted: ${r.source} / ${r.propertyName} → ${r.coverageStatus ?? ""} (${r.reason})`);
      }
    }
  }
} finally {
  closeDatabase(db);
}
