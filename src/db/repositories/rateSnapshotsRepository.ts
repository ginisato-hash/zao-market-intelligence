import type { RateSnapshot } from "../../domain/types";
import type { LocalDatabase } from "../client";

export function insertRateSnapshot(db: LocalDatabase, snapshot: RateSnapshot): void {
  db.prepare(
    `INSERT OR IGNORE INTO rate_snapshots (
      id,
      run_id,
      property_id,
      ota,
      stay_date,
      guests,
      nights,
      price_jpy,
      price_total_tax_included,
      availability_status,
      confidence,
      checked_at_jst,
      screenshot_key,
      raw_text_excerpt,
      error_reason,
      created_at
    )
    VALUES (
      @id,
      @runId,
      @propertyId,
      @ota,
      @stayDate,
      @guests,
      @nights,
      @priceJpy,
      @priceTotalTaxIncluded,
      @availabilityStatus,
      @confidence,
      @checkedAtJst,
      @screenshotKey,
      @rawTextExcerpt,
      @errorReason,
      @createdAt
    )`
  ).run({
    id: snapshot.id,
    runId: snapshot.runId,
    propertyId: snapshot.propertyId,
    ota: snapshot.ota,
    stayDate: snapshot.stayDate,
    guests: snapshot.guests,
    nights: snapshot.nights,
    priceJpy: snapshot.priceJpy,
    priceTotalTaxIncluded: snapshot.priceTotalTaxIncluded,
    availabilityStatus: snapshot.availabilityStatus,
    confidence: snapshot.confidence,
    checkedAtJst: snapshot.checkedAtJst,
    screenshotKey: snapshot.screenshotKey ?? null,
    rawTextExcerpt: snapshot.rawTextExcerpt ?? null,
    errorReason: snapshot.errorReason ?? null,
    createdAt: snapshot.createdAt
  });
}
