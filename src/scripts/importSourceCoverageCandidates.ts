import { importSourceCoverageCandidates } from "../seeds/importSourceCoverageCandidates";

const summary = importSourceCoverageCandidates();

console.log(`candidates_inserted=${summary.candidatesInserted}`);
console.log(`candidates_updated=${summary.candidatesUpdated}`);
console.log(`skipped_records=${summary.skippedRecords}`);
console.log(`count_by_source=${JSON.stringify(summary.countBySource)}`);
console.log(`count_by_verification_status=${JSON.stringify(summary.countByVerificationStatus)}`);
console.log(`property_resolved_count=${summary.propertyResolvedCount}`);
if (summary.skippedRecords > 0) {
  for (const skip of summary.skipped) {
    console.log(`  skipped: ${skip.reason}`);
  }
}
