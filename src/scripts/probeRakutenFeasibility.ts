import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import { runRakutenDateFieldProbe } from "../feasibility/rakutenDateFieldProbe";
import { updateSourceCoverageFromFeasibility } from "../services/updateSourceCoverageFromFeasibility";

async function main(): Promise<void> {
  let result;
  try {
    result = await runRakutenDateFieldProbe();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("probe_executed=false");
    console.log(`probe_not_executed_reason=${message}`);
    console.log("note=Browser/network unavailable; no coverage row written. This is not an implementation failure.");
    return;
  }

  const db = openLocalDatabase();
  try {
    executeMigration(db);
    const persisted = updateSourceCoverageFromFeasibility(db, result);
    console.log("probe_executed=true");
    console.log(`source=${result.source}`);
    console.log(`property_name=${result.propertyName}`);
    console.log(`status=${result.status}`);
    console.log(`access_status=${result.accessStatus}`);
    console.log(`notes=${result.notes}`);
    console.log(`checked_at_jst=${result.checkedAtJst}`);
    console.log(`debug_json_path=${result.debugJsonPath ?? ""}`);
    console.log(`safe_price_extracted=${result.safePriceExtracted ?? false}`);
    console.log(`coverage_property_id=${persisted.propertyId}`);
    console.log(`coverage_inserted=${persisted.inserted}`);
    console.log(`coverage_updated=${persisted.updated}`);
    console.log(`coverage_active=${persisted.active}`);
  } finally {
    closeDatabase(db);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
