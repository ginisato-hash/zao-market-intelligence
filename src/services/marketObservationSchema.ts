// Phase ZMI-MKT-OBS01 — Market Observation Data Plane (pure).
//
// A NEW, additive observation schema for competitor inventory/price
// time-series comparison. Deliberately SEPARATE from the existing
// zao_local_history_v1 schema (localHistorySchemaDesign.ts) rather than a
// retrofit: that schema's own FORBIDDEN_COLUMNS list bans any column
// containing "inventory" by design (a prior safety rail against conflating
// PMS/Beds24 inventory with OTA-observed inventory), and it has no concept of
// room/rate-plan product identity or search-context identity at all. Adding
// those concerns here, alongside the existing schema, keeps the existing
// price-history pipeline, reports, and dashboards completely untouched.
//
// Core principle (never violate): an OTA showing fewer rooms than a prior
// observation is OBSERVED_INVENTORY_DEPLETION, never "pickup" — a booking, an
// allocation cut, a stop-sell, and a rate-plan closure all look identical from
// the outside. ACTUAL_BOOKING_PICKUP is reserved for cases backed by real
// reservation/PMS data, which this collector never has. No fabricated
// precision: unavailable fields are UNKNOWN, not guessed.
//
// No I/O, no network.

import { createHash } from "node:crypto";

export const MARKET_OBSERVATION_SCHEMA_VERSION = "zao_market_observation_v1";

export type ObservationSourcePlatform = "booking" | "jalan" | "rakuten" | "google_hotels";

// §4 — what a numeric inventory_count actually represents. Never collapse to
// one generic "rooms_available_exact" field; the semantics decide how (and
// whether) a value may be compared or interpreted downstream.
export type InventoryCountSemantics =
  | "PRODUCT_UNITS_AVAILABLE" // a specific room+rate combination's own remaining count
  | "ROOM_TYPE_UNITS_AVAILABLE" // a room-type-level remaining count (rate-plan-agnostic)
  | "PUBLIC_SCARCITY_COUNT" // OTA UI "残り2室"/"あと3部屋"-style badge text
  | "BINARY_AVAILABILITY" // no count at all, only available/sold_out
  | "UNKNOWN"; // could not determine

// §5 — what UNIT the count (if any) is scoped to. A "残り2室" badge next to
// one specific room card is PRODUCT or SEARCH_CONTEXT scope, never PROPERTY —
// never assume it describes the whole property's remaining inventory.
export type InventoryScope = "PROPERTY" | "ROOM_TYPE" | "PRODUCT" | "SEARCH_CONTEXT" | "UNKNOWN";

// §20 — failure semantics kept distinct. A scrape/parse failure is never
// silently turned into sold_out, and a page that doesn't list the property at
// all (delisted, not offered on this OTA) is never sold_out either.
export type ObservationAvailabilityStatus =
  | "AVAILABLE"
  | "SOLD_OUT"
  | "NOT_LISTED"
  | "COLLECTION_FAILED"
  | "PARSE_FAILED"
  | "UNKNOWN";

// Row-level extraction confidence (distinct from the day-level aggregate
// quality tiers in marketObservationQuality.ts, which need multiple rows).
export type ObservationSourceQuality = "HIGH" | "MEDIUM" | "LOW";

export interface MarketObservationRow {
  observationId: string;
  observationHash: string;
  propertyId: string;
  propertyName: string;
  sourcePlatform: ObservationSourcePlatform;
  stayDate: string; // YYYY-MM-DD
  observedAtJst: string; // ISO, real collection instant — never fabricated/backfilled
  roomProductKey: string; // see productIdentityStabilization.ts; "" when no room evidence at all
  roomTypeName: string;
  ratePlanKey: string;
  ratePlanName: string;
  searchAdults: number;
  searchChildren: number;
  searchRooms: number;
  lengthOfStay: number;
  currency: string;
  observedPrice: number | null;
  availabilityStatus: ObservationAvailabilityStatus;
  inventoryCount: number | null;
  inventoryCountSemantics: InventoryCountSemantics;
  inventoryScope: InventoryScope;
  sourceQuality: ObservationSourceQuality;
  rawEvidenceHash: string; // hash of the raw text/block the row was extracted from
  collectorRunId: string;
}

export const MARKET_OBSERVATION_CSV_HEADERS = [
  "observation_id",
  "observation_hash",
  "property_id",
  "property_name",
  "source_platform",
  "stay_date",
  "observed_at_jst",
  "room_product_key",
  "room_type_name",
  "rate_plan_key",
  "rate_plan_name",
  "search_adults",
  "search_children",
  "search_rooms",
  "length_of_stay",
  "currency",
  "observed_price",
  "availability_status",
  "inventory_count",
  "inventory_count_semantics",
  "inventory_scope",
  "source_quality",
  "raw_evidence_hash",
  "collector_run_id"
] as const;

// Never let this NEW schema accidentally reintroduce the ambiguity it exists
// to fix: a bare, unscoped "count" column, or an invented exact PMS-style
// figure. inventory_count is only ever paired with an explicit semantics +
// scope column — enforced structurally by MarketObservationRow, and checked
// here defensively for any hand-built column list.
export const FORBIDDEN_OBSERVATION_COLUMNS: readonly string[] = [
  "rooms_available_exact",
  "exact_inventory",
  "beds24",
  "airhost",
  "pms",
  "actual_booking_pickup"
];

export function shardMonthFromStayDate(stayDate: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/u.exec(stayDate);
  if (!m) throw new Error(`stayDate must be YYYY-MM-DD: ${stayDate}`);
  return `${m[1]}_${m[2]}`;
}

export function buildObservationId(parts: {
  sourcePlatform: string;
  propertyId: string;
  stayDate: string;
  roomProductKey: string;
  ratePlanKey: string;
  searchAdults: number;
  searchChildren: number;
  searchRooms: number;
  lengthOfStay: number;
  collectorRunId: string;
}): string {
  return [
    parts.sourcePlatform,
    parts.propertyId,
    parts.stayDate,
    parts.roomProductKey || "unknown_product",
    parts.ratePlanKey || "unknown_rate",
    parts.searchAdults,
    parts.searchChildren,
    parts.searchRooms,
    parts.lengthOfStay,
    parts.collectorRunId
  ].join("|");
}

// Excludes collectorRunId/observedAtJst deliberately: this hash identifies
// "the same observed fact" for dedup purposes across retries of the SAME
// run (see marketObservationAppend.ts), not across genuinely distinct runs —
// callers combine this with observationId (which DOES include collectorRunId)
// for the actual duplicate-suppression identity per §11.
export function buildObservationHash(row: {
  propertyId: string;
  sourcePlatform: string;
  stayDate: string;
  roomProductKey: string;
  ratePlanKey: string;
  searchAdults: number;
  searchChildren: number;
  searchRooms: number;
  lengthOfStay: number;
  currency: string;
  observedPrice: number | null;
  availabilityStatus: string;
  inventoryCount: number | null;
  inventoryCountSemantics: string;
  inventoryScope: string;
}): string {
  const stable = [
    row.propertyId,
    row.sourcePlatform,
    row.stayDate,
    row.roomProductKey,
    row.ratePlanKey,
    row.searchAdults,
    row.searchChildren,
    row.searchRooms,
    row.lengthOfStay,
    row.currency,
    row.observedPrice === null ? "null" : String(row.observedPrice),
    row.availabilityStatus,
    row.inventoryCount === null ? "null" : String(row.inventoryCount),
    row.inventoryCountSemantics,
    row.inventoryScope
  ].join("|");
  return createHash("sha256").update(stable).digest("hex");
}

export function hashRawEvidence(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function validateObservationColumns(columns: readonly string[]): string[] {
  const errors: string[] = [];
  const lower = columns.map((c) => c.toLowerCase());
  for (const forbidden of FORBIDDEN_OBSERVATION_COLUMNS) {
    if (lower.some((c) => c === forbidden || c.includes(forbidden))) errors.push(`forbidden_column:${forbidden}`);
  }
  for (const required of MARKET_OBSERVATION_CSV_HEADERS) {
    if (!columns.includes(required)) errors.push(`missing_column:${required}`);
  }
  return errors;
}

export function validateObservationRow(row: MarketObservationRow): string[] {
  const errors: string[] = [];
  if (!row.observationId.trim()) errors.push("observation_id_empty");
  if (!row.propertyId.trim()) errors.push("property_id_empty");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(row.stayDate)) errors.push("stay_date_invalid_format");
  if (!row.observedAtJst.trim()) errors.push("observed_at_jst_empty");
  if (!row.collectorRunId.trim()) errors.push("collector_run_id_empty");
  // §4/§16 guardrail: a numeric count with UNKNOWN semantics or scope is
  // half-fabricated precision — either both are meaningful, or the count
  // itself must be null.
  if (row.inventoryCount !== null && (row.inventoryCountSemantics === "UNKNOWN" || row.inventoryScope === "UNKNOWN")) {
    errors.push("inventory_count_present_without_semantics_or_scope");
  }
  if (row.observedPrice !== null && row.observedPrice <= 0) errors.push("observed_price_non_positive");
  return errors;
}

export function toObservationCsvRow(row: MarketObservationRow): string[] {
  return [
    row.observationId,
    row.observationHash,
    row.propertyId,
    row.propertyName,
    row.sourcePlatform,
    row.stayDate,
    row.observedAtJst,
    row.roomProductKey,
    row.roomTypeName,
    row.ratePlanKey,
    row.ratePlanName,
    String(row.searchAdults),
    String(row.searchChildren),
    String(row.searchRooms),
    String(row.lengthOfStay),
    row.currency,
    row.observedPrice === null ? "" : String(row.observedPrice),
    row.availabilityStatus,
    row.inventoryCount === null ? "" : String(row.inventoryCount),
    row.inventoryCountSemantics,
    row.inventoryScope,
    row.sourceQuality,
    row.rawEvidenceHash,
    row.collectorRunId
  ];
}
