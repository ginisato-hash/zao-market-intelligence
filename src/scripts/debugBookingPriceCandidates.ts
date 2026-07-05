// Phase ZMI HAMMOND-PRICE-FIX01 — read-only Booking price-candidate diagnostics.
//
// Live-fetches a fixed set of Booking property/checkin cells (mirroring the
// exact request shape runPricingCriticalRecrawl.ts uses: headless Chromium,
// group_adults=2, no_rooms=1), saves the rendered body text for offline
// inspection, and reports EVERY extracted yen candidate — which one
// selectPrimaryBookingPriceCandidate chose, and why the others were passed
// over. No history append, no DB write, no publish, no launchd change.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  sanitizeBookingUrl,
  selectPrimaryBookingPriceCandidate
} from "../services/bookingRenderedDomProbe";

const OUT_DIR = ".data/debug/hammond-price-fix";
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-booking-preview/0.1; low-volume bounded preview)";

interface DebugTarget { canonicalPropertyName: string; slug: string; checkin: string }

const DEFAULT_TARGETS: DebugTarget[] = [
  { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya", checkin: "2026-07-06" },
  { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya", checkin: "2026-07-10" },
  { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya", checkin: "2026-07-11" }
];

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function fileTs(): string { const d = new Date(); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

async function run(): Promise<void> {
  const targets = DEFAULT_TARGETS;
  const generatedAtJst = jstNow();
  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  const results: unknown[] = [];
  try {
    for (const t of targets) {
      const checkout = checkoutForOneNight(t.checkin);
      const probeUrl = buildBookingRenderedDomUrl({ canonicalPropertyName: t.canonicalPropertyName, slug: t.slug, checkin: t.checkin });
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      let loaded = false, httpStatus = 0, finalUrl = probeUrl, pageTitle = "", bodyText = "", error = "";
      try {
        const response = await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        loaded = response !== null; httpStatus = response?.status() ?? 0;
        await page.waitForTimeout(5_000);
        finalUrl = page.url();
        pageTitle = await page.title().catch(() => "");
        bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); finalUrl = page.url() || probeUrl; }
      finally { await page.close().catch(() => undefined); }

      const bodyTextPath = join(OUT_DIR, `${t.slug}_${t.checkin}_${fileTs()}.txt`);
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(bodyTextPath, bodyText, "utf8");

      const signals = analyzeBookingRenderedDomSignals({ target: t, checkin: t.checkin, checkout, loaded, httpStatus, finalUrl, pageTitle, bodyText, error });
      const selection = selectPrimaryBookingPriceCandidate(bodyText, signals.priceCandidates);

      const candidateCards = selection.scored.map((c) => ({
        price_text: c.rawText,
        price_numeric: c.numericValue,
        context: c.contextBeforeAfter,
        candidate_type_guess: c.candidateTypeGuess,
        room_name: c.roomContext.primaryRoomName,
        bed_hint: c.roomContext.primaryBedHint,
        has_room_context: c.hasRoomContext,
        is_plausible: c.isPlausible,
        is_selected: selection.selected !== null && c.rawText === selection.selected.rawText && c.numericValue === selection.selected.numericValue,
        reason: c.isPlausible && c.hasRoomContext ? "plausible_with_room_context" : c.isPlausible ? "plausible_no_room_context" : "implausible_booking_price_under_1000"
      }));

      const result = {
        property: t.canonicalPropertyName,
        source: "booking",
        checkin: t.checkin,
        url: sanitizeBookingUrl(probeUrl),
        loaded,
        http_status: httpStatus,
        error,
        body_text_length: bodyText.length,
        body_text_snapshot_path: resolve(bodyTextPath),
        candidate_count: selection.scored.length,
        selected_price_numeric: selection.selected?.numericValue ?? null,
        selected_room_name: signals.primaryRoomName,
        selected_bed_hint: signals.primaryBedHint,
        room_basis_input: { roomName: signals.primaryRoomName, bedHint: signals.primaryBedHint, occupancyHint: signals.primaryOccupancyHint },
        candidate_cards: candidateCards.filter((c) => c.is_selected),
        rejected_candidates: candidateCards.filter((c) => !c.is_selected)
      };
      results.push(result);
      console.log(`property=${t.canonicalPropertyName} checkin=${t.checkin} candidate_count=${selection.scored.length} selected_price=${selection.selected?.numericValue ?? "null"} selected_room_name="${signals.primaryRoomName}" selected_bed_hint="${signals.primaryBedHint}"`);
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const jsonPath = resolve(OUT_DIR, `hammond_price_debug_${fileTs()}.json`);
  writeFileSync(jsonPath, `${JSON.stringify({ generated_at_jst: generatedAtJst, targets: results }, null, 2)}\n`, "utf8");
  console.log(`decision=hammond_price_debug_ready`);
  console.log(`json_path=${jsonPath}`);
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
