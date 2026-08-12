// Phase ZMI-MKT-OBS03 — handoff artifact sanity validation (pure). §11.
//
// Independent post-hoc audit of a generated handoff artifact. Deliberately
// re-derives its checks from the artifact's OWN published values rather than
// from the generator's internals, so a generator bug cannot validate itself.
//
// No I/O, no network.

import type { MarketSignalHandoffArtifact, MarketSignalHandoffRow } from "./marketSignalHandoffContract";

export type HandoffValidationCode =
  | "duplicate_product_key"
  | "invalid_delta"
  | "numeric_pair_missing_delta"
  | "binary_only_with_zero_delta"
  | "cross_product_binding"
  | "future_timestamp"
  | "t0_t1_reversal"
  | "malformed_price"
  | "forbidden_pickup_terminology"
  | "property_scoped_scarcity";

export interface HandoffValidationFinding {
  code: HandoffValidationCode;
  detail: string;
}

function identityKey(row: MarketSignalHandoffRow): string {
  const i = row.identity;
  return [i.property_id, i.source, i.stay_date, i.room_product_key, i.rate_plan_key, i.adults, i.children, i.requested_rooms, i.length_of_stay, i.currency].join("|");
}

/**
 * nowMs is injected so the "future timestamp" check is deterministic and the
 * validator stays pure.
 */
export function validateHandoffArtifact(artifact: MarketSignalHandoffArtifact, nowMs: number): HandoffValidationFinding[] {
  const findings: HandoffValidationFinding[] = [];

  // T0 must precede T1 — a reversed pair would invert every delta's sign.
  const t0 = Date.parse(artifact.pair.t0_first_observed_jst);
  const t1 = Date.parse(artifact.pair.t1_first_observed_jst);
  if (Number.isFinite(t0) && Number.isFinite(t1) && t0 >= t1) {
    findings.push({ code: "t0_t1_reversal", detail: `t0=${artifact.pair.t0_first_observed_jst} >= t1=${artifact.pair.t1_first_observed_jst}` });
  }
  for (const [label, ts] of [["t0", t0], ["t1", t1]] as const) {
    if (Number.isFinite(ts) && ts > nowMs) findings.push({ code: "future_timestamp", detail: `${label} is in the future` });
  }

  // One signal per comparison key: a duplicate would double-count a movement.
  const seen = new Map<string, number>();
  for (const row of artifact.signals) {
    const key = identityKey(row);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) findings.push({ code: "duplicate_product_key", detail: `${count}x ${key}` });
  }

  for (const row of artifact.signals) {
    const s = row.scarcity;
    const p = row.price;
    const key = identityKey(row);

    // §7 no-movement semantics, audited from the published values alone.
    const bothNumeric =
      s.inventory_count_t0 !== null &&
      s.inventory_count_t1 !== null &&
      s.inventory_semantics !== "BINARY_AVAILABILITY" &&
      s.inventory_semantics !== "UNKNOWN";
    if (bothNumeric && row.quality.pair_comparable) {
      if (s.observed_inventory_delta === null || s.inventory_delta_known !== true) {
        findings.push({ code: "numeric_pair_missing_delta", detail: key });
      } else if (s.observed_inventory_delta !== s.inventory_count_t1! - s.inventory_count_t0!) {
        findings.push({ code: "invalid_delta", detail: `${key}: ${s.inventory_count_t0}->${s.inventory_count_t1} delta=${s.observed_inventory_delta}` });
      }
    }
    // A binary-only pair must never carry a quantity delta at all — 0 there
    // would be a quantity invented from an availability flag.
    if (s.inventory_semantics === "BINARY_AVAILABILITY" || s.inventory_semantics === "UNKNOWN") {
      if (s.observed_inventory_delta !== null || s.inventory_delta_known === true) {
        findings.push({ code: "binary_only_with_zero_delta", detail: `${key}: delta=${String(s.observed_inventory_delta)} known=${String(s.inventory_delta_known)}` });
      }
    }

    // §6 price arithmetic must be internally consistent with its own endpoints.
    if (p.competitor_price_t0 !== null && p.competitor_price_t1 !== null && row.quality.pair_comparable) {
      const expected = p.competitor_price_t1 - p.competitor_price_t0;
      if (p.price_change_yen !== expected) {
        findings.push({ code: "malformed_price", detail: `${key}: ${p.competitor_price_t0}->${p.competitor_price_t1} yen=${String(p.price_change_yen)}` });
      }
      const expectedDir = expected > 0 ? "PRICE_UP" : expected < 0 ? "PRICE_DOWN" : "PRICE_UNCHANGED";
      if (p.price_direction !== expectedDir) {
        findings.push({ code: "malformed_price", detail: `${key}: direction=${String(p.price_direction)} expected=${expectedDir}` });
      }
    }
    for (const v of [p.competitor_price_t0, p.competitor_price_t1]) {
      if (v !== null && (!Number.isFinite(v) || v <= 0)) findings.push({ code: "malformed_price", detail: `${key}: non-positive price ${String(v)}` });
    }

    // §5 scarcity must never have been promoted to whole-property inventory.
    if (s.inventory_scope === "PROPERTY") {
      findings.push({ code: "property_scoped_scarcity", detail: key });
    }

    // §4 vocabulary.
    const transition = s.inventory_transition ?? "";
    if (/pickup/iu.test(transition) || /decline/iu.test(transition)) {
      findings.push({ code: "forbidden_pickup_terminology", detail: `${key}: ${transition}` });
    }
  }

  // Cross-product binding: within a single stay_date+source+property, two
  // DIFFERENT room products must not report byte-identical price endpoints AND
  // identical scarcity endpoints under different keys — that is the signature of
  // one product's values having been copied across rows.
  const byGroup = new Map<string, MarketSignalHandoffRow[]>();
  for (const row of artifact.signals) {
    const g = [row.identity.property_id, row.identity.source, row.identity.stay_date].join("|");
    const bucket = byGroup.get(g);
    if (bucket === undefined) byGroup.set(g, [row]);
    else bucket.push(row);
  }
  for (const [g, rows] of byGroup) {
    const fingerprint = new Map<string, string[]>();
    for (const r of rows) {
      // Only a numeric scarcity fingerprint is distinctive enough to accuse;
      // identical prices alone are common and legitimate (same rate across rooms).
      if (r.scarcity.inventory_count_t0 === null || r.scarcity.inventory_count_t1 === null) continue;
      const fp = [r.price.competitor_price_t0, r.price.competitor_price_t1, r.scarcity.inventory_count_t0, r.scarcity.inventory_count_t1].join("/");
      const list = fingerprint.get(fp);
      if (list === undefined) fingerprint.set(fp, [r.identity.room_product_key]);
      else list.push(r.identity.room_product_key);
    }
    for (const [fp, keys] of fingerprint) {
      const distinct = new Set(keys);
      // >1 distinct product sharing an identical (price,price,inv,inv) tuple is
      // reported for review, not asserted as a defect: real pages can legitimately
      // price two rooms identically with equal remaining counts.
      if (distinct.size > 1) {
        findings.push({ code: "cross_product_binding", detail: `${g}: ${distinct.size} products share ${fp}` });
      }
    }
  }

  return findings;
}

/** Findings that make the artifact unusable vs. ones that only warrant review. */
export const HANDOFF_FATAL_CODES: readonly HandoffValidationCode[] = [
  "duplicate_product_key",
  "invalid_delta",
  "numeric_pair_missing_delta",
  "binary_only_with_zero_delta",
  "future_timestamp",
  "t0_t1_reversal",
  "malformed_price",
  "forbidden_pickup_terminology",
  "property_scoped_scarcity"
];

export function summarizeHandoffValidation(findings: readonly HandoffValidationFinding[]): {
  total: number;
  fatal: number;
  review: number;
  byCode: Record<string, number>;
} {
  const byCode: Record<string, number> = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  const fatal = findings.filter((f) => HANDOFF_FATAL_CODES.includes(f.code)).length;
  return { total: findings.length, fatal, review: findings.length - fatal, byCode };
}
