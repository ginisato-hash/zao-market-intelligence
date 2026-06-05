import { chromium } from "playwright";
import type { AvailabilityStatus, CollectorInput, CollectorResult } from "../domain/types";
import type { ScreenshotStorage } from "../services/screenshotStorage";
import { createScreenshotKey } from "../utils/screenshotKey";
import { formatJstDateTime } from "../utils/date";
import { createId } from "../utils/ids";
import { buildRakutenAttemptUrl } from "./rakutenUrl";
import { detectRakutenStatus } from "./rakutenStatusDetection";
import { analyzeRakutenExtractionEvidence } from "./rakutenEvidence";
import { decideRakutenCollectorResult, type RakutenCollectorDecision } from "./rakutenCollectorDecision";
import { writeRakutenDebugArtifact, buildAccessStrategy } from "./rakutenDebugArtifact";
import { inspectRakutenForm, type RakutenFormInspectionResult } from "./rakutenFormInspector";
import {
  isRakutenSearchFormText,
  performRakutenSearchInteraction,
  type RakutenSearchInteractionResult
} from "./rakutenSearchInteraction";
import type { RakutenExtractionEvidence } from "./rakutenEvidence";

export interface RakutenCollectorOptions {
  screenshotStorage: ScreenshotStorage;
  timeoutMs?: number;
}

// Error reasons that indicate the navigation or interaction itself failed (not plan content found)
const NAVIGATION_FAILED_REASONS = new Set([
  "rakuten_overview_page_no_plan_results",
  "rakuten_plan_results_not_reached",
  "rakuten_search_click_no_plan_results",
  "rakuten_search_button_not_found",
  "rakuten_search_conditions_not_set",
  "rakuten_search_interaction_failed",
  "rakuten_plan_url_404_not_found",
]);

export class RakutenCollector {
  constructor(private readonly options: RakutenCollectorOptions) {}

  async collect(input: CollectorInput): Promise<CollectorResult[]> {
    return [await this.collectOne(input)];
  }

  private async collectOne(input: CollectorInput): Promise<CollectorResult> {
    if (input.propertyUrl === undefined || input.propertyUrl === null || input.propertyUrl.trim() === "") {
      return buildRakutenCollectorResult(input, { status: "failed", priceJpy: null, errorReason: "Rakuten property_url is required." });
    }

    const timeout = this.options.timeoutMs ?? 20_000;
    let attemptUrl = "";
    let screenshotPath: string | undefined;
    let evidence: RakutenExtractionEvidence | undefined;
    let formInspection: RakutenFormInspectionResult | undefined;
    let searchInteraction: RakutenSearchInteractionResult = {
      attempted: false,
      success: false,
      strategy: "not_attempted",
      beforeUrl: ""
    };

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        userAgent: "Mozilla/5.0 (compatible; zao-market-intelligence-prototype/0.1; low-volume manual verification)"
      });
      page.setDefaultTimeout(timeout);

      // Strategy: load the overview URL with condition params in the query string.
      // The /PLAN/ path was confirmed 404. The overview page has a search form.
      attemptUrl = buildRakutenAttemptUrl(input);
      await page.goto(attemptUrl, { waitUntil: "load", timeout });
      await page.waitForTimeout(5_000);

      let bodyText = await page.locator("body").innerText({ timeout: 5_000 });

      // If the overview search form is detected, inspect DOM then attempt one search button click
      if (isRakutenSearchFormText(bodyText)) {
        // Capture DOM metadata for diagnostic purposes (read-only, no side-effects)
        formInspection = await inspectRakutenForm(page);

        // Extract condition dates from the already-built attempt URL
        const urlObj = new URL(attemptUrl);
        const checkinDate = urlObj.searchParams.get("f_checkin_date") ?? "";
        const checkoutDate = urlObj.searchParams.get("f_checkout_date") ?? "";
        const adults = input.adults ?? input.guests;
        const rooms = input.rooms ?? 1;

        searchInteraction = await performRakutenSearchInteraction(
          page,
          { checkinDate, checkoutDate, adults, rooms },
          timeout
        );

        if (searchInteraction.success) {
          // Re-read body text with plan results (if loaded)
          bodyText = await page.locator("body").innerText({ timeout: 5_000 });
        }
      }

      const finalUrl = page.url();
      screenshotPath = await this.captureScreenshot(page, input);

      const statusDetection = detectRakutenStatus(bodyText);
      evidence = analyzeRakutenExtractionEvidence({ text: bodyText, stayDate: input.stayDate, attemptUrl });
      let decision = decideRakutenCollectorResult(evidence, statusDetection);

      // If the search was attempted+succeeded but the page still shows the overview form, use a more specific error
      if (
        searchInteraction.attempted &&
        searchInteraction.success &&
        evidence.rejectionReason === "rakuten_overview_page_no_plan_results"
      ) {
        decision = { status: "failed", priceJpy: null, errorReason: "rakuten_search_click_no_plan_results" };
      }

      // If the search interaction itself failed, propagate its error reason
      if (searchInteraction.attempted && !searchInteraction.success && searchInteraction.errorReason !== undefined) {
        decision = { status: "failed", priceJpy: null, errorReason: searchInteraction.errorReason };
      }

      const effectiveErrorReason = decision.errorReason;
      const reachedPlanResults = !NAVIGATION_FAILED_REASONS.has(effectiveErrorReason ?? "");

      const accessStrategy = buildAccessStrategy({
        attemptedUrl: attemptUrl,
        searchInteraction,
        reachedPlanResults,
        finalUrl,
        ...(effectiveErrorReason !== undefined ? { rejectionReason: effectiveErrorReason } : {})
      });

      const result = buildRakutenCollectorResult(input, decision, screenshotPath);
      await writeRakutenDebugArtifact({
        runId: input.runId,
        propertyName: input.propertyName,
        propertyUrl: input.propertyUrl,
        attemptUrl,
        stayDate: input.stayDate,
        status: result.rateSnapshot.availabilityStatus,
        evidence,
        selectedPrice: result.rateSnapshot.priceTotalTaxIncluded,
        errorReason: result.rateSnapshot.errorReason ?? null,
        screenshotPath,
        bodyTextExcerpt: bodyText.slice(0, 8000),
        rakutenAccessStrategy: accessStrategy,
        ...(formInspection !== undefined ? { rakutenFormInspection: formInspection } : {})
      });
      return result;
    } catch (error) {
      const errorReason = error instanceof Error ? `Rakuten collector failed: ${error.message}` : "Rakuten collector failed.";
      const result = buildRakutenCollectorResult(
        input,
        { status: "failed", priceJpy: null, errorReason },
        screenshotPath
      );
      const accessStrategy = buildAccessStrategy({
        attemptedUrl: attemptUrl,
        searchInteraction: { ...searchInteraction, errorReason: errorReason },
        reachedPlanResults: false,
        finalUrl: attemptUrl,
        rejectionReason: errorReason
      });
      await writeRakutenDebugArtifact({
        runId: input.runId,
        propertyName: input.propertyName,
        propertyUrl: input.propertyUrl ?? "",
        attemptUrl,
        stayDate: input.stayDate,
        status: "failed",
        evidence: evidence ?? fallbackEvidence(input.stayDate, errorReason),
        selectedPrice: null,
        errorReason,
        ...(screenshotPath !== undefined ? { screenshotPath } : {}),
        rakutenAccessStrategy: accessStrategy,
        ...(formInspection !== undefined ? { rakutenFormInspection: formInspection } : {})
      });
      return result;
    } finally {
      await browser.close();
    }
  }

  private async captureScreenshot(
    page: import("playwright").Page,
    input: CollectorInput
  ): Promise<string> {
    const body = await page.screenshot({ fullPage: true });
    const key = createScreenshotKey({
      capturedAt: new Date(),
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "rakuten",
      stayDate: input.stayDate,
      jobId: input.jobId ?? createId("rakuten_job")
    });
    const stored = await this.options.screenshotStorage.putObject({
      key,
      contentType: "image/png",
      body
    });
    return stored.path;
  }
}

export function buildRakutenCollectorResult(
  input: CollectorInput,
  decision: RakutenCollectorDecision,
  screenshotPath?: string
): CollectorResult {
  const checkedAtJst = formatJstDateTime();
  const price = decision.status === "available" && decision.priceJpy !== null ? decision.priceJpy : null;
  const status: AvailabilityStatus =
    price === null && decision.status === "available" ? "failed" : decision.status;

  return {
    rateSnapshot: {
      id: createId("rate"),
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "rakuten",
      stayDate: input.stayDate,
      guests: input.adults ?? input.guests,
      nights: input.nights,
      priceJpy: price,
      priceTotalTaxIncluded: price,
      availabilityStatus: status,
      confidence: price !== null ? "B" : "C",
      checkedAtJst,
      ...(screenshotPath !== undefined ? { screenshotKey: screenshotPath } : {}),
      ...(decision.errorReason !== undefined
        ? { errorReason: decision.errorReason }
        : status === "failed"
          ? { errorReason: "rakuten_price_or_status_unclear" }
          : {}),
      createdAt: checkedAtJst
    },
    inventorySnapshot: {
      id: createId("inventory"),
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "rakuten",
      stayDate: input.stayDate,
      availabilityStatus: status,
      confidence: price !== null ? "B" : "C",
      checkedAtJst,
      createdAt: checkedAtJst
    }
  };
}

function fallbackEvidence(stayDate: string, rejectionReason: string): RakutenExtractionEvidence {
  return {
    stayDate,
    selectedDateEvidenceFound: false,
    availabilityMarkerFound: false,
    priceFound: false,
    priceBasis: "unknown",
    confidence: "low",
    rejectionReason
  };
}
