// Phase ZMI-MKT-OBS01 — CORE competitor repeated observation collector.
//
// Market Observation Data Plane upgrade for Refine V2: collects BOTH Booking
// and Jalan for the 3 CORE competitors (HAMMOND / 吉田屋 / ONSEN & STAY
// OAKHILL) over a FIXED, identical horizon every run (§10 — never an
// asymmetric "today D+90, this evening D+30" comparison), and writes rows
// into the NEW, additive market-observation schema (marketObservationSchema.ts)
// — never into .data/history, never touching Beds24/PMS/RMS/Refine pricing.
//
// Default mode is --preview (no live fetch, no write) unless COLLECT_LIVE=1
// is set. Append to .data/market-observations is gated separately behind
// ZMI_APPEND_MARKET_OBSERVATIONS=1, mirroring the existing
// runPricingCriticalRecrawl.ts fail-closed convention.
//
// This script is meant to run TWICE a day (an AM pass and a PM pass, §9) —
// scheduling is a launchd concern (see ops/launchd/*.plist.template), not
// enforced here; this script just always covers the identical horizon so
// two same-day runs are directly comparable.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  sanitizeBookingUrl
} from "../services/bookingRenderedDomProbe";
import { collectTarget, ensureJalanDebugDirs } from "./probeJalanBoundedCollectionImproved";
import { type JalanProbeTarget } from "../services/jalanBoundedCollectionProbe";
import { CORE_COMPETITORS, type CoreCompetitorTarget } from "../services/coreCompetitorTargets";
import { extractJalanProductRecords, buildJalanProductKey } from "../collectors/jalanProductBlockExtractor";
import { buildRoomProductKey, buildRatePlanKey } from "../services/productIdentityStabilization";
import { extractInventoryScarcitySignal } from "../services/inventoryScarcityExtraction";
import {
  buildObservationId,
  buildObservationHash,
  hashRawEvidence,
  type MarketObservationRow,
  type ObservationAvailabilityStatus,
  type ObservationSourceQuality
} from "../services/marketObservationSchema";
import { suppressRetryDuplicates, buildRunManifest } from "../services/collectorRunManifest";
import { appendMarketObservations } from "../services/marketObservationAppend";
import { buildAdjacentTransitionPairs, generateBinaryTransition, generateNumericInventoryTransition, generatePriceTransition } from "../services/marketObservationTransitions";
import { assessDataQuality } from "../services/marketObservationQuality";
import { backoffDelayMs, classifyBlock, jitterDelayMs, shouldEarlyStop, sleep } from "../services/crawlThrottlePolicy";
import {
  acquireCollectorLock,
  createRunDeadline,
  releaseCollectorLock,
  type RunDeadline
} from "../services/collectorRunLock";

const DEBUG_ROOT = ".data/debug/core-competitor-repeated-observation";
const OUT_DIR = ".data/reports/market-observation";
const OBSERVATIONS_DIR = ".data/market-observations";
// PART B1 production-schedule guards. launchd has no "skip if still running"
// key for calendar jobs, so overlap exclusion and the wall-clock budget are
// both enforced in-process (see collectorRunLock.ts).
const LOCK_PATH = ".data/locks/core_competitor_observation.lock";
const RUN_TIMEOUT_MS = Number(process.env["ZMI_CORE_COMPETITOR_TIMEOUT_MS"] ?? "") || 45 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-market-observation/0.1; low-volume bounded)";
// Fixed, identical every run (§10) — the SAME horizon length regardless of
// when the script fires, never "today D+90, this evening D+30". Overridable
// only for bounded manual validation (e.g. a small integration-test pass);
// production always uses the 14-day default.
const HORIZON_DAYS = Number(process.env["ZMI_CORE_COMPETITOR_HORIZON_DAYS"] ?? "14") || 14;

function ts(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function jstIso(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function todayJstIso(): string {
  return jstIso().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
// §10 fixed horizon: D+1..D+HORIZON_DAYS, identical for every CORE competitor,
// every run — never asymmetric between properties or between an AM/PM pass.
function fixedHorizon(todayIso: string): string[] {
  return Array.from({ length: HORIZON_DAYS }, (_, i) => addDays(todayIso, i + 1));
}

function bookingClassificationToAvailability(classification: string): ObservationAvailabilityStatus {
  switch (classification) {
    case "booking_rendered_price_basis_candidate_found":
      return "AVAILABLE";
    case "booking_rendered_sold_out_or_unavailable":
      return "SOLD_OUT";
    case "booking_rendered_not_found":
      return "NOT_LISTED";
    case "booking_rendered_navigation_failed":
    case "booking_rendered_captcha_or_security":
    case "booking_rendered_login_required":
      return "COLLECTION_FAILED";
    case "booking_rendered_empty_or_near_empty":
      return "PARSE_FAILED";
    default:
      return "UNKNOWN"; // e.g. booking_rendered_content_visible_no_safe_price — content visible, no safe read
  }
}

function jalanStatusToAvailability(status: string): ObservationAvailabilityStatus {
  switch (status) {
    case "available":
      return "AVAILABLE";
    case "sold_out":
      return "SOLD_OUT";
    case "not_listed":
    case "not_found":
      return "NOT_LISTED";
    case "failed":
      return "COLLECTION_FAILED";
    default:
      return "UNKNOWN";
  }
}

async function collectBookingObservations(input: {
  competitors: readonly CoreCompetitorTarget[];
  stayDates: readonly string[];
  runId: string;
  debugPath: string;
  deadline: RunDeadline;
}): Promise<{ rows: MarketObservationRow[]; requestCount: number; rateLimitEvents: number; parseFailures: number; deadlineHit: boolean }> {
  const rows: MarketObservationRow[] = [];
  let requestCount = 0;
  let rateLimitEvents = 0;
  let parseFailures = 0;
  let deadlineHit = false;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  let consecutiveBlocks = 0;
  let backoffAttempt = 0;
  try {
    for (const competitor of input.competitors) {
      for (const stayDate of input.stayDates) {
        // Cooperative budget check BEFORE starting a new request, never mid-flight.
        if (input.deadline.exceeded()) { deadlineHit = true; break; }
        requestCount += 1;
        if (requestCount > 1) await sleep(jitterDelayMs());
        const target = { canonicalPropertyName: competitor.propertyName, slug: competitor.bookingSlug };
        const checkout = checkoutForOneNight(stayDate);
        const probeUrl = buildBookingRenderedDomUrl({ ...target, checkin: stayDate });
        const page = await context.newPage();
        page.setDefaultTimeout(45_000);
        let loaded = false, httpStatus = 0, finalUrl = probeUrl, pageTitle = "", bodyText = "", error = "";
        try {
          const response = await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
          loaded = response !== null;
          httpStatus = response?.status() ?? 0;
          await page.waitForTimeout(5_000);
          finalUrl = page.url();
          pageTitle = await page.title().catch(() => "");
          bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        } finally {
          await page.close().catch(() => undefined);
        }

        const signals = analyzeBookingRenderedDomSignals({ target, checkin: stayDate, checkout, loaded, httpStatus, finalUrl, pageTitle, bodyText, error });
        const domRow = buildBookingRenderedDomRow({
          target,
          checkin: stayDate,
          checkout,
          probeUrl,
          signals,
          debugArtifactPath: input.debugPath
        });
        const availability = bookingClassificationToAvailability(domRow.classification);
        if (availability === "PARSE_FAILED") parseFailures += 1;

        const scarcity = extractInventoryScarcitySignal(signals.primaryRoomCardText);
        const roomProductKey = buildRoomProductKey({ roomTypeName: signals.primaryRoomName, bedHint: signals.primaryBedHint });
        const ratePlanKey = ""; // Booking source capability: no distinct rate-plan text separate from the room card today (§3, honest UNKNOWN)

        const observedAtJst = jstIso();
        const partial = {
          propertyId: competitor.propertyId,
          sourcePlatform: "booking" as const,
          stayDate,
          roomProductKey,
          ratePlanKey,
          searchAdults: 2,
          searchChildren: 0,
          searchRooms: 1,
          lengthOfStay: 1,
          currency: "JPY",
          observedPrice: signals.primaryPriceCandidate?.numericValue ?? null,
          availabilityStatus: availability,
          inventoryCount: scarcity.inventoryCount,
          inventoryCountSemantics: scarcity.inventoryCountSemantics,
          inventoryScope: scarcity.inventoryScope
        };
        const observationId = buildObservationId({ ...partial, collectorRunId: input.runId });
        const observationHash = buildObservationHash(partial);
        const sourceQuality: ObservationSourceQuality = domRow.roomBasis === "confirmed_two_person_standard_room" ? "HIGH" : signals.primaryRoomName !== "" ? "MEDIUM" : "LOW";

        rows.push({
          observationId,
          observationHash,
          ...partial,
          propertyName: competitor.propertyName,
          observedAtJst,
          roomTypeName: signals.primaryRoomName,
          ratePlanName: "",
          sourceQuality,
          rawEvidenceHash: hashRawEvidence(signals.primaryRoomCardText || sanitizeBookingUrl(probeUrl)),
          collectorRunId: input.runId
        });

        const block = classifyBlock(httpStatus, `${pageTitle}\n${bodyText}\n${error}`);
        if (block !== null) {
          consecutiveBlocks += 1;
          rateLimitEvents += 1;
          await sleep(backoffDelayMs(backoffAttempt));
          backoffAttempt += 1;
          if (shouldEarlyStop(consecutiveBlocks)) break;
        } else {
          consecutiveBlocks = 0;
          backoffAttempt = 0;
        }
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  return { rows, requestCount, rateLimitEvents, parseFailures, deadlineHit };
}

async function collectJalanObservations(input: {
  competitors: readonly CoreCompetitorTarget[];
  stayDates: readonly string[];
  runId: string;
  debugPath: string;
  deadline: RunDeadline;
}): Promise<{ rows: MarketObservationRow[]; requestCount: number; parseFailures: number; deadlineHit: boolean }> {
  const rows: MarketObservationRow[] = [];
  let requestCount = 0;
  let parseFailures = 0;
  let deadlineHit = false;
  ensureJalanDebugDirs(input.debugPath);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const competitor of input.competitors) {
      for (const stayDate of input.stayDates) {
        if (input.deadline.exceeded()) { deadlineHit = true; break; }
        requestCount += 1;
        if (requestCount > 1) await sleep(jitterDelayMs());
        const checkout = checkoutForOneNight(stayDate);
        const target: JalanProbeTarget = {
          target_id: `${competitor.jalanYadId}_${stayDate}`,
          canonical_property_name: competitor.propertyName,
          facility_tier: "tier_2",
          jalan_yad_id: competitor.jalanYadId,
          source_slug_or_code: competitor.jalanYadId,
          source_url: `https://www.jalan.net/${competitor.jalanYadId}/`,
          target_url: `https://www.jalan.net/${competitor.jalanYadId}/plan/?stayYear=${stayDate.slice(0, 4)}&stayMonth=${stayDate.slice(5, 7)}&stayDay=${stayDate.slice(8, 10)}&stayCount=1&roomCount=1&roomCrack=200000&adultNum=2&childNum=0&yadNo=${competitor.jalanYadId.replace(/^yad/u, "")}`,
          checkin: stayDate,
          checkout,
          stay_nights: 1,
          group_adults: 2,
          no_rooms: 1,
          group_children: 0,
          currency: "JPY",
          language: "ja"
        };
        const runResult = await collectTarget({
          browser,
          target,
          runId: input.runId,
          checkedAt: jstIso(),
          debugPath: input.debugPath,
          reportPath: resolve(OUT_DIR, `${input.runId}_jalan.json`),
          csvPath: resolve(OUT_DIR, `${input.runId}_jalan.csv`)
        });
        const { row, bodyText } = runResult;
        const pageAvailability = jalanStatusToAvailability(row.availability_status);
        const observedAtJst = jstIso();

        // PART A: one observation per (room product x rate plan), each field
        // read from that product's OWN row segment. Replaces the previous
        // one-row-per-date shape, which had to pick a single "representative"
        // product out of a page listing many and consequently mixed one
        // room's name with another's price and a third's scarcity badge.
        const products = extractJalanProductRecords(bodyText);
        if (products.length === 0) {
          // No parseable product rows. Distinguish an honest page-level
          // sold-out / not-listed / navigation failure (recorded as such, with
          // no product identity) from a genuine parse failure on a page that
          // DID render content — never silently drop the cell either way.
          if (pageAvailability === "AVAILABLE" && bodyText.trim() !== "") parseFailures += 1;
          const partial = {
            propertyId: competitor.propertyId,
            sourcePlatform: "jalan" as const,
            stayDate,
            roomProductKey: "",
            ratePlanKey: "",
            searchAdults: 2,
            searchChildren: 0,
            searchRooms: 1,
            lengthOfStay: 1,
            currency: "JPY",
            observedPrice: null,
            availabilityStatus: pageAvailability === "AVAILABLE" ? ("PARSE_FAILED" as const) : pageAvailability,
            inventoryCount: null,
            inventoryCountSemantics: "UNKNOWN" as const,
            inventoryScope: "UNKNOWN" as const
          };
          rows.push({
            observationId: buildObservationId({ ...partial, collectorRunId: input.runId }),
            observationHash: buildObservationHash(partial),
            ...partial,
            propertyName: competitor.propertyName,
            observedAtJst,
            roomTypeName: "",
            ratePlanName: "",
            sourceQuality: "LOW",
            rawEvidenceHash: hashRawEvidence(bodyText || target.target_url),
            collectorRunId: input.runId
          });
          continue;
        }

        for (const product of products) {
          const roomProductKey = buildJalanProductKey({
            roomName: product.roomName,
            planName: product.planName,
            mealBasis: product.mealBasis,
            searchAdults: 2,
            searchChildren: 0,
            searchRooms: 1,
            lengthOfStay: 1
          });
          const partial = {
            propertyId: competitor.propertyId,
            sourcePlatform: "jalan" as const,
            stayDate,
            roomProductKey,
            ratePlanKey: buildRatePlanKey({ ratePlanName: product.planName }),
            searchAdults: 2,
            searchChildren: 0,
            searchRooms: 1,
            lengthOfStay: 1,
            currency: "JPY",
            // The RAW observed total, kept even when the older DP-usability
            // gate would have discarded it for meal basis — that gate was
            // hiding real observations (§16: ZMI observes, Refine decides).
            observedPrice: product.totalPriceTaxIncluded,
            availabilityStatus: "AVAILABLE" as const,
            inventoryCount: product.inventoryCount,
            inventoryCountSemantics: product.inventoryCountSemantics,
            inventoryScope: product.inventoryScope
          };
          rows.push({
            observationId: buildObservationId({ ...partial, collectorRunId: input.runId }),
            observationHash: buildObservationHash(partial),
            ...partial,
            propertyName: competitor.propertyName,
            observedAtJst,
            roomTypeName: product.roomName,
            ratePlanName: product.planName,
            // A product row carrying its own price AND its own scarcity badge
            // is the strongest read available from a text-scraped source.
            sourceQuality: product.inventoryCount !== null ? "HIGH" : "MEDIUM",
            rawEvidenceHash: hashRawEvidence(product.rawRowText),
            collectorRunId: input.runId
          });
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { rows, requestCount, parseFailures, deadlineHit };
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const appendMode = args.includes("--append");
  const liveGate = process.env["COLLECT_LIVE"] === "1";
  const todayIso = todayJstIso();
  const stayDates = fixedHorizon(todayIso);
  const runId = `core_competitor_obs_${ts()}`;
  const startedAt = jstIso();

  console.log(`decision=core_competitor_observation_${appendMode ? "append" : "preview"}`);
  console.log(`run_id=${runId}`);
  console.log(`today_jst=${todayIso}`);
  console.log(`horizon_days=${HORIZON_DAYS}`);
  console.log(`horizon_start=${stayDates[0]}`);
  console.log(`horizon_end=${stayDates[stayDates.length - 1]}`);
  console.log(`core_competitors=${JSON.stringify(CORE_COMPETITORS.map((c) => c.propertyId))}`);

  if (!liveGate) {
    console.log(`decision=core_competitor_observation_plan_only`);
    console.log(`note=set COLLECT_LIVE=1 to run a live batch`);
    return;
  }

  // Overlap prevention (B1): a still-running previous firing must never be
  // joined by the next one, or the outbound request rate silently doubles.
  const lock = acquireCollectorLock({ lockPath: LOCK_PATH, runId });
  if (!lock.acquired) {
    console.log(`decision=core_competitor_observation_aborted_lock_held`);
    console.log(`lock_held_age_ms=${lock.heldByAgeMs ?? "unknown"}`);
    console.log(`lock_owner=${(lock.ownerRaw ?? "").trim()}`);
    process.exitCode = 1;
    return;
  }
  if (lock.staleLockReclaimed) console.log(`stale_lock_reclaimed=true`);

  try {
    const deadline = createRunDeadline({ timeoutMs: RUN_TIMEOUT_MS });
    console.log(`run_timeout_ms=${RUN_TIMEOUT_MS}`);

    const debugPath = resolve(DEBUG_ROOT, ts());
    mkdirSync(debugPath, { recursive: true });
    mkdirSync(resolve(OUT_DIR), { recursive: true });

    const booking = await collectBookingObservations({ competitors: CORE_COMPETITORS, stayDates, runId, debugPath: resolve(debugPath, "booking"), deadline });
    const jalan = await collectJalanObservations({ competitors: CORE_COMPETITORS, stayDates, runId, debugPath: resolve(debugPath, "jalan"), deadline });
    const deadlineHit = booking.deadlineHit || jalan.deadlineHit;
    if (deadlineHit) console.log(`run_deadline_exceeded=true`);
    const allRows = [...booking.rows, ...jalan.rows];
    const { kept, suppressedCount } = suppressRetryDuplicates(allRows);
    const completedAt = jstIso();

    const manifest = buildRunManifest({
      runId,
      startedAt,
      completedAt,
      source: "booking+jalan",
      propertiesRequested: CORE_COMPETITORS.length,
      stayDatesRequested: stayDates.length,
      rows: kept,
      failedCount: kept.filter((r) => r.availabilityStatus === "COLLECTION_FAILED").length,
      parseFailureCount: booking.parseFailures + jalan.parseFailures,
      duplicatesSuppressed: suppressedCount,
      requestCount: booking.requestCount + jalan.requestCount,
      rateLimitEvents: booking.rateLimitEvents
    });

    console.log(`observations_collected=${kept.length}`);
    console.log(`duplicates_suppressed=${suppressedCount}`);
    console.log(`request_count=${manifest.requestCount}`);
    console.log(`rate_limit_events=${manifest.rateLimitEvents}`);
    console.log(`parse_failures=${manifest.parseFailures}`);

    for (const competitor of CORE_COMPETITORS) {
      const rows = kept.filter((r) => r.propertyId === competitor.propertyId);
      const pairs = buildAdjacentTransitionPairs(rows);
      const numeric = pairs.map(generateNumericInventoryTransition).filter((t) => t !== null).length;
      const binary = pairs.map(generateBinaryTransition).filter((t) => t !== null).length;
      const price = pairs.map(generatePriceTransition).filter((t) => t !== null).length;
      console.log(
        `${competitor.propertyId}_observations=${rows.length} ${competitor.propertyId}_numeric_transitions=${numeric} ${competitor.propertyId}_binary_transitions=${binary} ${competitor.propertyId}_price_transitions=${price}`
      );
    }

    const quality = stayDates.map((stayDate) => assessDataQuality({ stayDate, rows: kept, expectedCompetitorCount: CORE_COMPETITORS.length, nowIso: completedAt }));
    const insufficientCount = quality.filter((q) => q.tier === "INSUFFICIENT").length;
    console.log(`stay_dates_insufficient_quality=${insufficientCount}/${stayDates.length}`);

    const manifestPath = resolve(OUT_DIR, `${runId}_manifest.json`);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          manifest,
          quality,
          schedule_guards: {
            run_timeout_ms: RUN_TIMEOUT_MS,
            run_deadline_exceeded: deadlineHit,
            stale_lock_reclaimed: lock.staleLockReclaimed,
            lock_path: LOCK_PATH
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    console.log(`manifest_path=${manifestPath}`);

    if (!appendMode) {
      console.log(`decision=core_competitor_observation_preview_ready`);
      return;
    }

    if (process.env["ZMI_APPEND_MARKET_OBSERVATIONS"] === "1") {
      const result = appendMarketObservations({ observationsDir: OBSERVATIONS_DIR, runId, rows: kept });
      console.log(`append_decision=${result.decision}`);
      console.log(`rows_written=${result.rowsWritten}`);
      console.log(`rows_skipped_duplicate=${result.rowsSkippedDuplicate}`);
      console.log(`rows_conflict=${result.rowsConflict}`);
      console.log(`shards_written=${JSON.stringify(result.shardsWritten)}`);
    } else {
      console.log(`append_skipped=true`);
      console.log(`note=set ZMI_APPEND_MARKET_OBSERVATIONS=1 to append observations`);
    }

    console.log(`decision=core_competitor_observation_append_ready`);
  } finally {
    releaseCollectorLock(LOCK_PATH);
  }
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
