import { chromium } from "playwright";
import { formatJstDateTime } from "../utils/date";
import {
  buildSourceFeasibilityResult,
  writeFeasibilityDebugArtifact,
  type FeasibilityClassification,
  type SourceFeasibilityResult
} from "../services/sourceFeasibilityResult";

/**
 * Fixed, human-verifiable Google Hotels probe scope. This probe uses ONLY the
 * public Google Travel hotel-entity page. It deliberately uses NO SerpAPI, NO
 * paid SERP API, NO Google API key, NO hidden/internal Google endpoints, NO
 * proxy, NO stealth, and NO login cookies. The realistic expected outcome is
 * "unsupported" (consent wall / JS-rendered SPA without safe data), which is an
 * accurate, acceptable feasibility result. The probe never extracts or persists
 * a price.
 */
export const GOOGLE_HOTELS_PROBE_SCOPE = {
  source: "google_hotels",
  propertyName: "ル・ベール蔵王",
  sourcePropertyId: "CgoIn_eG0v78uPpiEAE",
  propertyUrl: "https://www.google.com/travel/hotels/entity/CgoIn_eG0v78uPpiEAE"
} as const;

const CAPTCHA_PATTERN = /(captcha|recaptcha|unusual traffic|通常と異なるトラフィック|ロボットではありません)/iu;
const BLOCK_PATTERN = /(access denied|forbidden|403|アクセスが拒否)/iu;
const CONSENT_PATTERN = /(consent\.google|before you continue|begin browsing|同意して続行|プライバシーとデータ|すべて同意)/iu;

// Google Travel renders hotel pricing through client-side JS. A meaningful
// amount of visible text is required before we even consider the page usable;
// below this the page is effectively a consent/JS wall.
const MIN_USABLE_BODY_LENGTH = 400;

export interface GoogleHotelsFreeDirectSignals {
  loaded: boolean;
  bodyText: string;
  bodyTextLength: number;
  finalUrl: string;
}

/**
 * Pure, network-free classification. Never throws, never extracts a price.
 * Defaults toward "unsupported" because the public page does not expose a
 * safe, date-scoped tax-included total without paid/hidden APIs.
 */
export function classifyGoogleHotelsFreeDirectProbe(
  signals: GoogleHotelsFreeDirectSignals
): FeasibilityClassification {
  if (!signals.loaded) {
    return {
      status: "unsupported",
      accessStatus: "page_not_loaded",
      notes: "Google Hotels probe page did not load; treated as unsupported via free access."
    };
  }
  const text = signals.bodyText;
  if (CAPTCHA_PATTERN.test(text)) {
    return {
      status: "captcha",
      accessStatus: "captcha_or_unusual_traffic",
      notes: "Google presented a CAPTCHA / unusual-traffic challenge."
    };
  }
  if (BLOCK_PATTERN.test(text)) {
    return {
      status: "blocked",
      accessStatus: "access_blocked",
      notes: "Google blocked access to the hotel entity page."
    };
  }
  if (CONSENT_PATTERN.test(text) || signals.bodyTextLength < MIN_USABLE_BODY_LENGTH) {
    return {
      status: "unsupported",
      accessStatus: "consent_or_js_wall",
      notes:
        "Google Hotels served a consent wall / JS-rendered shell without safe data. " +
        "Unsupported via free, non-API access; no price extracted."
    };
  }
  return {
    status: "unsupported",
    accessStatus: "no_safe_free_price_path",
    notes:
      "Google Hotels content was visible but exposes no safe, date-scoped tax-included total without paid/hidden APIs. " +
      "Unsupported via free access; no price extracted."
  };
}

/**
 * One-shot Playwright runner against the public Google Travel entity page only.
 * No retries, no stealth, no proxy, no login, no API keys, no hidden endpoints.
 * Never persists a price. Not exercised by the test suite.
 */
export async function runGoogleHotelsFreeDirectProbe(
  options: { timeoutMs?: number } = {}
): Promise<SourceFeasibilityResult> {
  const timeout = options.timeoutMs ?? 20_000;
  const checkedAtJst = formatJstDateTime();
  const scope = GOOGLE_HOTELS_PROBE_SCOPE;

  const browser = await chromium.launch({ headless: true });
  let signals: GoogleHotelsFreeDirectSignals = {
    loaded: false,
    bodyText: "",
    bodyTextLength: 0,
    finalUrl: scope.propertyUrl
  };
  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (compatible; zao-market-intelligence-feasibility/0.1; low-volume manual verification)"
    });
    page.setDefaultTimeout(timeout);

    await page.goto(scope.propertyUrl, { waitUntil: "load", timeout });
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

  const classification = classifyGoogleHotelsFreeDirectProbe(signals);
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
