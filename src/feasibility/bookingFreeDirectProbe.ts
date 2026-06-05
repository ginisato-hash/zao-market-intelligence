import { chromium } from "playwright";
import { formatJstDateTime } from "../utils/date";
import {
  buildSourceFeasibilityResult,
  writeFeasibilityDebugArtifact,
  type FeasibilityClassification,
  type SourceFeasibilityResult
} from "../services/sourceFeasibilityResult";

/**
 * Fixed, human-verifiable Booking.com probe scope. One property, one date, one
 * night, two adults, one room, JPY, Japanese. We expect this probe to be
 * blocked (empty / near-empty body from upstream bot detection); a clean
 * "blocked" recording is a SUCCESSFUL, accurate feasibility result, not a
 * failure. The probe never extracts or persists a price.
 */
export const BOOKING_PROBE_SCOPE = {
  source: "booking",
  propertyName: "ル・ベール蔵王",
  sourcePropertyId: "le-vert-zao",
  checkin: "2026-08-08",
  checkout: "2026-08-09",
  nights: 1,
  adults: 2,
  rooms: 1
} as const;

export function buildBookingProbeUrl(scope: typeof BOOKING_PROBE_SCOPE = BOOKING_PROBE_SCOPE): string {
  const params = new URLSearchParams({
    checkin: scope.checkin,
    checkout: scope.checkout,
    group_adults: String(scope.adults),
    no_rooms: String(scope.rooms),
    group_children: "0",
    lang: "ja",
    selected_currency: "JPY"
  });
  return `https://www.booking.com/hotel/jp/${scope.sourcePropertyId}.ja.html?${params.toString()}`;
}

const CAPTCHA_PATTERN = /(captcha|recaptcha|are you a robot|ロボットではありません|セキュリティチェック)/iu;
const LOGIN_PATTERN = /(sign in to|please log ?in|ログインしてください|サインインが必要)/iu;
const NOT_FOUND_PATTERN = /(404|page not found|ページが見つかりません|お探しのページ)/iu;

// Below this body length we treat the response as empty / near-empty, which is
// the signature of Booking's upstream bot detection serving a stripped page.
const NEAR_EMPTY_BODY_THRESHOLD = 300;

export interface BookingFreeDirectSignals {
  loaded: boolean;
  bodyText: string;
  bodyTextLength: number;
  finalUrl: string;
}

/**
 * Pure, network-free classification. Never throws, never extracts a price.
 * Empty / near-empty body is the expected (and acceptable) blocked outcome.
 */
export function classifyBookingFreeDirectProbe(signals: BookingFreeDirectSignals): FeasibilityClassification {
  if (!signals.loaded) {
    return {
      status: "blocked",
      accessStatus: "page_not_loaded",
      notes: "Booking probe page did not load; treated as blocked."
    };
  }
  const text = signals.bodyText;
  if (CAPTCHA_PATTERN.test(text)) {
    return {
      status: "captcha",
      accessStatus: "captcha_challenge_detected",
      notes: "Booking presented a CAPTCHA / security challenge."
    };
  }
  if (signals.bodyTextLength < NEAR_EMPTY_BODY_THRESHOLD) {
    return {
      status: "blocked",
      accessStatus: "empty_or_near_empty_body",
      notes:
        "Booking returned an empty / near-empty body (upstream bot detection). " +
        "Recorded as blocked; this is an expected, accurate result."
    };
  }
  if (LOGIN_PATTERN.test(text)) {
    return {
      status: "login_required",
      accessStatus: "login_required",
      notes: "Booking required login/sign-in to proceed."
    };
  }
  if (NOT_FOUND_PATTERN.test(text)) {
    return {
      status: "not_found",
      accessStatus: "page_not_found_404",
      notes: "Booking returned a 404 / page-not-found for the probe URL."
    };
  }
  return {
    status: "needs_review",
    accessStatus: "content_visible_no_safe_price",
    notes:
      "Booking page content was visible but no date-scoped tax-included total was safely extracted. " +
      "Needs manual review; no price extracted."
  };
}

/**
 * One-shot Playwright runner. Loads the date-scoped Booking URL once and
 * classifies the body. No retries, no stealth, no proxy, no login, no CAPTCHA
 * bypass. Never persists a price. Not exercised by the test suite.
 */
export async function runBookingFreeDirectProbe(options: { timeoutMs?: number } = {}): Promise<SourceFeasibilityResult> {
  const timeout = options.timeoutMs ?? 20_000;
  const checkedAtJst = formatJstDateTime();
  const scope = BOOKING_PROBE_SCOPE;
  const url = buildBookingProbeUrl(scope);

  const browser = await chromium.launch({ headless: true });
  let signals: BookingFreeDirectSignals = {
    loaded: false,
    bodyText: "",
    bodyTextLength: 0,
    finalUrl: url
  };
  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (compatible; zao-market-intelligence-feasibility/0.1; low-volume manual verification)"
    });
    page.setDefaultTimeout(timeout);

    await page.goto(url, { waitUntil: "load", timeout });
    await page.waitForTimeout(4_000);

    const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    signals = {
      loaded: true,
      bodyText,
      bodyTextLength: bodyText.trim().length,
      finalUrl: page.url()
    };
  } catch (error) {
    signals = {
      ...signals,
      loaded: false,
      bodyText: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await browser.close();
  }

  const classification = classifyBookingFreeDirectProbe(signals);
  const result = buildSourceFeasibilityResult({
    source: scope.source,
    propertyName: scope.propertyName,
    sourcePropertyId: scope.sourcePropertyId,
    propertyUrl: url,
    classification,
    checkedAtJst
  });
  const debugJsonPath = await writeFeasibilityDebugArtifact(result, {
    scope,
    signals: { ...signals, bodyText: signals.bodyText.slice(0, 4_000) }
  });
  return { ...result, debugJsonPath };
}
