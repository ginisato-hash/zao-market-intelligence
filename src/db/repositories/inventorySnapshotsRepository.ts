import type { InventorySnapshot } from "../../domain/types";
import type { LocalDatabase } from "../client";

export function insertInventorySnapshot(db: LocalDatabase, snapshot: InventorySnapshot): void {
  db.prepare(
    `INSERT OR IGNORE INTO inventory_snapshots (
      id,
      run_id,
      property_id,
      ota,
      stay_date,
      availability_status,
      confidence,
      checked_at_jst,
      created_at
    )
    VALUES (
      @id,
      @runId,
      @propertyId,
      @ota,
      @stayDate,
      @availabilityStatus,
      @confidence,
      @checkedAtJst,
      @createdAt
    )`
  ).run({
    id: snapshot.id,
    runId: snapshot.runId,
    propertyId: snapshot.propertyId,
    ota: snapshot.ota,
    stayDate: snapshot.stayDate,
    availabilityStatus: snapshot.availabilityStatus,
    confidence: snapshot.confidence,
    checkedAtJst: snapshot.checkedAtJst,
    createdAt: snapshot.createdAt
  });
}
