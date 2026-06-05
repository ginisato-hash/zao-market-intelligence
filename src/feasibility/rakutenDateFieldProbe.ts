import { chromium } from "playwright";
import { formatJstDateTime } from "../utils/date";
import {
  buildSourceFeasibilityResult,
  writeFeasibilityDebugArtifact,
  type FeasibilityClassification,
  type SourceFeasibilityResult
} from "../services/sourceFeasibilityResult";

/**
 * A single, fixed, human-verifiable probe scope. The probe targets exactly one
 * property, one date, one night, two adults, one room. It exists to answer one
 * question: can we programmatically write the stay date into Rakuten's search
 * form and have it reflected, without bot-blocking? It never extracts or
 * persists a price.
 */
export const RAKUTEN_PROBE_SCOPE = {
  source: "rakuten",
  propertyName: "ル・ベール蔵王",
  sourcePropertyId: "29465",
  propertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
  stayDate: "2026-08-08",
  checkoutDate: "2026-08-09",
  nights: 1,
  adults: 2,
  rooms: 1
} as const;

const CAPTCHA_PATTERN = /(captcha|recaptcha|ロボットではありません|私はロボットではありません)/iu;
const BLOCK_PATTERN = /(アクセスが集中|不正なアクセス|invalid access|しばらく時間をおいて|access denied|forbidden|403)/iu;
const LOGIN_PATTERN = /(ログインしてください|サインインが必要|please log ?in|sign ?in required)/iu;
const NOT_FOUND_PATTERN = /(404 not found|指定されたページが見つかりません|ページが見つかりません)/iu;

/**
 * Rakuten reflects the chosen stay date into the result URL via one of these
 * query parameters. Any non-empty value means the date write took effect.
 */
const RAKUTEN_DATE_PARAMS = [
  "f_hizuke",
  "f_checkin_date",
  "f_checkin",
  "f_nen1",
  "f_tuki1",
  "f_hi1"
];

export function rakutenDateReflectedInUrl(finalUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    return false;
  }
  return RAKUTEN_DATE_PARAMS.some((param) => {
    const value = parsed.searchParams.get(param);
    return value !== null && value.trim() !== "";
  });
}

export interface RakutenDateFieldSignals {
  loaded: boolean;
  bodyText: string;
  finalUrl: string;
  expectedFieldsPresent: boolean;
  dateReflectedInUrl: boolean;
}

/**
 * Pure, network-free classification. Never throws, never extracts price.
 * Order of precedence: hard access failures (captcha/block/login/404) first,
 * then form-field presence, then whether the date write was reflected.
 */
export function classifyRakutenDateFieldProbe(signals: RakutenDateFieldSignals): FeasibilityClassification {
  if (!signals.loaded) {
    return {
      status: "needs_review",
      accessStatus: "page_not_loaded",
      notes: "Probe page did not load; result inconclusive."
    };
  }
  const text = signals.bodyText;
  if (CAPTCHA_PATTERN.test(text)) {
    return {
      status: "captcha",
      accessStatus: "captcha_challenge_detected",
      notes: "Rakuten presented a CAPTCHA / robot challenge."
    };
  }
  if (BLOCK_PATTERN.test(text)) {
    return {
      status: "blocked",
      accessStatus: "access_blocked_or_rate_limited",
      notes: "Rakuten blocked or rate-limited the request."
    };
  }
  if (LOGIN_PATTERN.test(text)) {
    return {
      status: "login_required",
      accessStatus: "login_required",
      notes: "Rakuten required login/sign-in to proceed."
    };
  }
  if (NOT_FOUND_PATTERN.test(text)) {
    return {
      status: "not_found",
      accessStatus: "page_not_found_404",
      notes: "Rakuten returned a 404 / page-not-found for the probe URL."
    };
  }
  if (!signals.expectedFieldsPresent) {
    return {
      status: "needs_review",
      accessStatus: "expected_fields_missing",
      notes: "Expected Rakuten search-form date fields were not present on the page."
    };
  }
  if (signals.dateReflectedInUrl) {
    return {
      status: "needs_review",
      accessStatus: "date_write_reflected",
      notes:
        "Stay date was written into the search form and reflected in the result URL. " +
        "Feasible for follow-up; no price extracted."
    };
  }
  return {
    status: "needs_review",
    accessStatus: "date_write_not_reflected",
    notes:
      "Search form was present but the written stay date was not reflected in the result URL. " +
      "Needs manual review; no price extracted."
  };
}

/**
 * One-shot Playwright runner. Loads the property overview URL, writes the fixed
 * stay date into the form fields, clicks the search button ONCE, then classifies
 * the resulting page. No calendar-widget interaction, no retries, no stealth,
 * no proxy, no login. Never persists a price.
 *
 * Not exercised by the test suite (requires a real browser + network). If the
 * browser or network is unavailable, the caller reports "not executed".
 */
export async function runRakutenDateFieldProbe(options: { timeoutMs?: number } = {}): Promise<SourceFeasibilityResult> {
  const timeout = options.timeoutMs ?? 20_000;
  const checkedAtJst = formatJstDateTime();
  const scope = RAKUTEN_PROBE_SCOPE;

  const browser = await chromium.launch({ headless: true });
  let signals: RakutenDateFieldSignals = {
    loaded: false,
    bodyText: "",
    finalUrl: scope.propertyUrl,
    expectedFieldsPresent: false,
    dateReflectedInUrl: false
  };
  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (compatible; zao-market-intelligence-feasibility/0.1; low-volume manual verification)"
    });
    page.setDefaultTimeout(timeout);

    await page.goto(scope.propertyUrl, { waitUntil: "load", timeout });
    await page.waitForTimeout(4_000);

    const [year, month, day] = scope.stayDate.split("-");
    const [outYear, outMonth, outDay] = scope.checkoutDate.split("-");

    const expectedFieldsPresent = await fillRakutenDateFields(page, {
      year: year ?? "",
      month: String(Number(month)),
      day: String(Number(day)),
      outYear: outYear ?? "",
      outMonth: String(Number(outMonth)),
      outDay: String(Number(outDay)),
      adults: String(scope.adults),
      rooms: String(scope.rooms)
    });

    if (expectedFieldsPresent) {
      const submit = page.locator("#dh-submit, button[type=submit], input[type=submit]").first();
      if ((await submit.count()) > 0) {
        await submit.click({ timeout }).catch(() => undefined);
        await page.waitForTimeout(4_000);
      }
    }

    const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const finalUrl = page.url();
    signals = {
      loaded: true,
      bodyText,
      finalUrl,
      expectedFieldsPresent,
      dateReflectedInUrl: rakutenDateReflectedInUrl(finalUrl)
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

  const classification = classifyRakutenDateFieldProbe(signals);
  const result = buildSourceFeasibilityResult({
    source: scope.source,
    propertyName: scope.propertyName,
    sourcePropertyId: scope.sourcePropertyId,
    propertyUrl: scope.propertyUrl,
    classification,
    checkedAtJst
  });
  const debugJsonPath = await writeFeasibilityDebugArtifact(result, {
    scope,
    signals: { ...signals, bodyText: signals.bodyText.slice(0, 4_000) }
  });
  return { ...result, debugJsonPath };
}

async function fillRakutenDateFields(
  page: import("playwright").Page,
  values: {
    year: string;
    month: string;
    day: string;
    outYear: string;
    outMonth: string;
    outDay: string;
    adults: string;
    rooms: string;
  }
): Promise<boolean> {
  const selectIfPresent = async (selector: string, value: string): Promise<boolean> => {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      return false;
    }
    await locator.selectOption(value).catch(async () => {
      await locator.fill(value).catch(() => undefined);
    });
    return true;
  };

  const checkinYear = await selectIfPresent("select[name=f_nen1]", values.year);
  const checkinMonth = await selectIfPresent("select[name=f_tuki1]", values.month);
  const checkinDay = await selectIfPresent("select[name=f_hi1]", values.day);
  await selectIfPresent("select[name=f_nen2]", values.outYear);
  await selectIfPresent("select[name=f_tuki2]", values.outMonth);
  await selectIfPresent("select[name=f_hi2]", values.outDay);
  await selectIfPresent("select[name=f_otona_su]", values.adults);
  await selectIfPresent("select[name=f_heya_su]", values.rooms);

  return checkinYear && checkinMonth && checkinDay;
}
