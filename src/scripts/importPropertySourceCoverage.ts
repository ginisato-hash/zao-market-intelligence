import { importPropertySourceCoverage } from "../seeds/importPropertySourceCoverage";

const summary = importPropertySourceCoverage();

console.log(`coverage_inserted=${summary.coverageInserted}`);
console.log(`coverage_updated=${summary.coverageUpdated}`);
console.log(`skipped_records=${summary.skippedRecords}`);
console.log(`count_by_source=${JSON.stringify(summary.countBySource)}`);
console.log(`count_by_coverage_status=${JSON.stringify(summary.countByCoverageStatus)}`);
console.log(`properties_inserted=${summary.propertiesInserted}`);
console.log(`alias_resolved_count=${summary.aliasResolvedCount}`);
for (const skip of summary.skipped) {
  console.log(`skipped reason="${skip.reason}"`);
}
