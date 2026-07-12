// Phase ZMI KIRAKU-BOOKING-FIX01 — read-only live investigation of why 喜らく
// (ZAO SPA HOTEL Kiraku, Booking slug xi-raku) has ZERO Booking-source history
// rows despite being a registered own-property Booking target. No append, no
// history write, no publish, no launchd change. Saves full debug artifacts to
// .data/debug/kiraku-booking/<timestamp>/<checkin>/ for reproducibility.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  sanitizeBookingUrl,
  selectPrimaryBookingPriceCandidate
} from "../services/bookingRenderedDomProbe";
import { classifyBookingRoomBasis } from "../services/roomBasisClassification";

const TARGET = { canonicalPropertyName: "ホテル喜らく", slug: "xi-raku" };
const OUT_ROOT = ".data/debug/kiraku-booking";
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-booking-preview/0.1; low-volume bounded preview)";

// §3: nearest weekday, nearest Saturday, +7..14d weekday, +7..14d Saturday,
// +30d, +60d, peak-demand (Obon week), weak-demand (early Sept midweek).
const CHECKINS = [
  "2026-07-14", // nearest weekday (Tue)
  "2026-07-18", // nearest Saturday
  "2026-07-22", // +9d weekday (Wed)
  "2026-07-25", // +12d Saturday
  "2026-08-12", // +30d (Wed)
  "2026-09-11", // +60d (Fri)
  "2026-08-14", // peak demand: Obon week (Fri)
  "2026-09-02"  // weak demand: early Sept midweek (Wed)
];

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function fileTs(): string { const d = new Date(); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

async function run(): Promise<void> {
  const runTs = fileTs();
  const runRoot = resolve(OUT_ROOT, runTs);
  mkdirSync(runRoot, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  const results: unknown[] = [];
  try {
    for (const checkin of CHECKINS) {
      const checkout = checkoutForOneNight(checkin);
      const probeUrl = buildBookingRenderedDomUrl({ ...TARGET, checkin });
      const dayDir = resolve(runRoot, checkin);
      await mkdir(dayDir, { recursive: true });
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      let loaded = false, httpStatus = 0, finalUrl = probeUrl, pageTitle = "", bodyText = "", html = "", error = "";
      try {
        const response = await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        loaded = response !== null; httpStatus = response?.status() ?? 0;
        await page.waitForTimeout(5_000);
        finalUrl = page.url();
        pageTitle = await page.title().catch(() => "");
        bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
        html = await page.content().catch(() => "");
        await page.screenshot({ path: resolve(dayDir, "page.png"), fullPage: true }).catch(() => undefined);
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); finalUrl = page.url() || probeUrl; }
      finally { await page.close().catch(() => undefined); }

      await writeFile(resolve(dayDir, "page.html"), html, "utf8");
      await writeFile(resolve(dayDir, "body_text.txt"), bodyText, "utf8");
      await writeFile(resolve(dayDir, "probe_url_sanitized.txt"), sanitizeBookingUrl(probeUrl), "utf8");

      const signals = analyzeBookingRenderedDomSignals({ target: TARGET, checkin, checkout, loaded, httpStatus, finalUrl, pageTitle, bodyText, error });
      const selection = selectPrimaryBookingPriceCandidate(bodyText.replace(/\s+/gu, " ").trim(), signals.priceCandidates);

      const roomCards = selection.scored.map((c) => {
        const roomBasis = classifyBookingRoomBasis({
          roomName: c.roomContext.primaryRoomName,
          blockText: c.roomContext.primaryRoomCardText,
          bedHint: c.roomContext.primaryBedHint,
          occupancyHint: c.roomContext.primaryOccupancyHint,
          available: c.isPlausible,
          hasPrice: true
        });
        return {
          price_text: c.rawText,
          price_numeric: c.numericValue,
          role_guess: c.roleGuess,
          block_guess: c.blockGuess,
          is_plausible: c.isPlausible,
          has_room_context: c.hasRoomContext,
          room_name: c.roomContext.primaryRoomName,
          bed_hint: c.roomContext.primaryBedHint,
          occupancy_hint: c.roomContext.primaryOccupancyHint,
          room_card_text: c.roomContext.primaryRoomCardText,
          room_basis: roomBasis.roomBasis,
          room_basis_reason: roomBasis.reason,
          is_selected: selection.selected !== null && c.rawText === selection.selected.rawText && c.numericValue === selection.selected.numericValue
        };
      });

      const priceCandidatesJson = { checkin, url: sanitizeBookingUrl(probeUrl), final_url: sanitizeBookingUrl(finalUrl), page_title: pageTitle, loaded, http_status: httpStatus, error, body_text_length: bodyText.length, candidates: roomCards };
      await writeFile(resolve(dayDir, "price_candidates.json"), `${JSON.stringify(priceCandidatesJson, null, 2)}\n`, "utf8");
      await writeFile(resolve(dayDir, "room_cards.json"), `${JSON.stringify(roomCards, null, 2)}\n`, "utf8");

      const classification = {
        checkin,
        selected_price_numeric: selection.selected?.numericValue ?? null,
        original_price_numeric: signals.originalPriceNumeric,
        price_discount_detected: signals.priceDiscountDetected,
        primary_room_name: signals.primaryRoomName,
        primary_bed_hint: signals.primaryBedHint,
        primary_occupancy_hint: signals.primaryOccupancyHint,
        no_usable_room_price_reason: signals.noUsableRoomPriceReason,
        related_property_price_excluded_count: signals.relatedPropertyPriceExcludedCount,
        sold_out_or_unavailable_detected: signals.soldOutOrUnavailableDetected,
        property_name_detected: signals.propertyNameDetected,
        checkin_detected: signals.checkinDetected,
        adult_count_detected: signals.adultCountDetected
      };
      await writeFile(resolve(dayDir, "classification.json"), `${JSON.stringify(classification, null, 2)}\n`, "utf8");

      results.push({ ...classification, candidate_count: roomCards.length, debug_dir: dayDir });
      console.log(`checkin=${checkin} selected_price=${selection.selected?.numericValue ?? "null"} room_name="${signals.primaryRoomName}" bed_hint="${signals.primaryBedHint}" no_usable_reason=${signals.noUsableRoomPriceReason ?? "n/a"} sold_out=${signals.soldOutOrUnavailableDetected} candidates=${roomCards.length}`);
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const summaryPath = resolve(runRoot, "summary.json");
  writeFileSync(summaryPath, `${JSON.stringify({ generated_at_jst: jstNow(), target: TARGET, results }, null, 2)}\n`, "utf8");
  console.log(`decision=kiraku_booking_investigation_ready`);
  console.log(`summary_json=${summaryPath}`);
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
