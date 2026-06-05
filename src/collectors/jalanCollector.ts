import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { AvailabilityStatus, CollectorInput, CollectorResult } from "../domain/types";
import type { ScreenshotStorage } from "../services/screenshotStorage";
import { createScreenshotKey } from "../utils/screenshotKey";
import { formatJstDateTime } from "../utils/date";
import { createId } from "../utils/ids";
import { detectJalanStatus } from "./jalanStatusDetection";
import {
  analyzeJalanExtractionEvidence,
  analyzeJalanPlanPageExtractionEvidence,
  buildJalanRawTextExcerpt,
  type JalanExtractionEvidence
} from "./jalanEvidence";
import { decideJalanCollectorResult } from "./jalanCollectorDecision";
import { writeJalanDebugArtifact } from "./jalanDebugArtifact";
import type { JalanAcceptedPricePolicyDebug } from "./jalanDebugArtifact";
import { attemptJalanPlanNavigation, type JalanPlanNavigationResult } from "./jalanPlanNavigation";
import {
  buildPlanBlockDebugSummary,
  collectVisibleJalanPlanBlockTexts,
  extractJalanPlanBlocks,
  planBlockCandidateToEvidence,
  type JalanPlanBlockDebugSummary
} from "./jalanPlanBlockExtractor";
import { selectAcceptedJalanPriceCandidate } from "./jalanAcceptedPricePolicy";

export interface JalanCollectorOptions {
  screenshotStorage: ScreenshotStorage;
  timeoutMs?: number;
}

export class JalanCollector {
  constructor(private readonly options: JalanCollectorOptions) {}

  async collect(input: CollectorInput): Promise<CollectorResult[]> {
    const result = await this.collectOne(input);
    return [result];
  }

  private async collectOne(input: CollectorInput): Promise<CollectorResult> {
    if (input.propertyUrl === undefined || input.propertyUrl === null || input.propertyUrl.trim() === "") {
      return createResult(input, {
        status: "failed",
        errorReason: "Jalan property_url is required for the real prototype collector."
      });
    }

    let browser: Browser | undefined;
    let page: Page | undefined;
    let screenshotPath: string | undefined;
    let rawTextExcerpt = "";

    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({
        userAgent:
          "Mozilla/5.0 (compatible; zao-market-intelligence-prototype/0.1; low-volume manual verification)"
      });
      page.setDefaultTimeout(this.options.timeoutMs ?? 20_000);

      await page.goto(buildJalanAttemptUrl(input), { waitUntil: "domcontentloaded", timeout: this.options.timeoutMs ?? 20_000 });
      await page.waitForTimeout(1_000);

      const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
      screenshotPath = await this.captureScreenshot(page, input);

      const statusDetection = detectJalanStatus(bodyText);
      const initialEvidence = analyzeJalanExtractionEvidence(bodyText, input.stayDate);
      let evidence = initialEvidence;
      let navigation: JalanPlanNavigationResult = {
        attempted: false,
        strategy: "not_attempted",
        success: false,
        beforeUrl: page.url(),
        errorReason: "not_needed"
      };
      let planBlockExtraction: JalanPlanBlockDebugSummary | undefined;
      let acceptedPricePolicy: JalanAcceptedPricePolicyDebug | undefined;
      const attemptUrlHasStayCondition = urlHasPrototypeStayCondition(page.url(), input);

      if (
        (initialEvidence.selectedDateTextFound &&
          initialEvidence.availabilityMarkerFound &&
          (!initialEvidence.priceFound || initialEvidence.confidence === "low")) ||
        attemptUrlHasStayCondition
      ) {
        navigation = await attemptJalanPlanNavigation({
          page,
          collectorInput: input,
          screenshotStorage: this.options.screenshotStorage
        });
        if (navigation.success && navigation.evidenceText !== undefined) {
          const blockTexts = await collectVisibleJalanPlanBlockTexts(page);
          const extraction = extractJalanPlanBlocks({
            blockTexts,
            pageUrl: navigation.afterUrl ?? page.url(),
            stayDate: input.stayDate,
            adults: input.adults ?? input.guests,
            rooms: input.rooms ?? 1,
            nights: input.nights
          });
          const selection = selectAcceptedJalanPriceCandidate(
            extraction.candidates,
            "cheapest_total_tax_included_safe_plan"
          );
          planBlockExtraction = buildPlanBlockDebugSummary(extraction);
          acceptedPricePolicy = buildAcceptedPricePolicyDebug(selection);
          evidence =
            (selection.selectedCandidate === undefined
              ? null
              : planBlockCandidateToEvidence(selection.selectedCandidate, input.stayDate)) ??
            analyzeJalanPlanPageExtractionEvidence(navigation.evidenceText, input.stayDate, navigation.afterUrl ?? page.url());
        }
      }

      const decision = decideJalanCollectorResult(evidence, statusDetection);
      rawTextExcerpt = buildJalanRawTextExcerpt(evidence, decision.errorReason);

      const result = createResult(input, {
        status: decision.status,
        ...(decision.priceJpy === null ? {} : { priceJpy: decision.priceJpy }),
        screenshotPath,
        rawTextExcerpt,
        ...(decision.errorReason === undefined ? {} : { errorReason: decision.errorReason })
      });
      await writeDebugArtifact(input, result, evidence, screenshotPath, rawTextExcerpt, navigation, planBlockExtraction, acceptedPricePolicy);
      return result;
    } catch (error) {
      if (page !== undefined && screenshotPath === undefined) {
        try {
          screenshotPath = await this.captureScreenshot(page, input);
        } catch {
          screenshotPath = undefined;
        }
      }

      const result = createResult(input, {
        status: "failed",
        rawTextExcerpt,
        ...(screenshotPath === undefined ? {} : { screenshotPath }),
        errorReason: error instanceof Error ? `Jalan collector failed: ${error.message}` : "Jalan collector failed."
      });
      await writeDebugArtifact(
        input,
        result,
        fallbackEvidence(input.stayDate, result.rateSnapshot.errorReason),
        screenshotPath,
        rawTextExcerpt || result.rateSnapshot.errorReason || "",
        {
          attempted: false,
          strategy: "not_attempted",
          success: false,
          beforeUrl: input.propertyUrl ?? "",
          ...(result.rateSnapshot.errorReason === undefined ? {} : { errorReason: result.rateSnapshot.errorReason })
        }
      );
      return result;
    } finally {
      await browser?.close();
    }
  }

  private async captureScreenshot(page: Page, input: CollectorInput): Promise<string> {
    const body = await page.screenshot({ fullPage: true });
    const key = createScreenshotKey({
      capturedAt: new Date(),
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "jalan",
      stayDate: input.stayDate,
      jobId: input.jobId ?? createId("jalan_job")
    });
    const stored = await this.options.screenshotStorage.putObject({
      key,
      contentType: "image/png",
      body
    });
    return stored.path;
  }
}

function createResult(
  input: CollectorInput,
  output: {
    status: AvailabilityStatus;
    priceJpy?: number;
    screenshotPath?: string;
    rawTextExcerpt?: string;
    errorReason?: string;
  }
): CollectorResult {
  const checkedAtJst = formatJstDateTime();
  const price = output.status === "available" ? output.priceJpy ?? null : null;

  return {
    rateSnapshot: {
      id: createId("rate"),
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "jalan",
      stayDate: input.stayDate,
      guests: input.adults ?? input.guests,
      nights: input.nights,
      priceJpy: price,
      priceTotalTaxIncluded: price,
      availabilityStatus: price === null && output.status === "available" ? "failed" : output.status,
      confidence: price === null ? "C" : "B",
      checkedAtJst,
      ...(output.screenshotPath === undefined ? {} : { screenshotKey: output.screenshotPath }),
      ...(output.rawTextExcerpt === undefined ? {} : { rawTextExcerpt: output.rawTextExcerpt }),
      ...(output.errorReason === undefined && !(price === null && output.status === "available")
        ? {}
        : { errorReason: output.errorReason ?? "Available status had no conservative tax-included price." }),
      createdAt: checkedAtJst
    },
    inventorySnapshot: {
      id: createId("inventory"),
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "jalan",
      stayDate: input.stayDate,
      availabilityStatus: price === null && output.status === "available" ? "failed" : output.status,
      confidence: price === null ? "C" : "B",
      checkedAtJst,
      createdAt: checkedAtJst
    }
  };
}

function fallbackEvidence(stayDate: string, rejectionReason?: string): JalanExtractionEvidence {
  return {
    stayDate,
    availabilityMarkerFound: false,
    priceFound: false,
    priceBasis: "unknown",
    selectedDateTextFound: false,
    confidence: "low",
    ...(rejectionReason === undefined ? {} : { rejectionReason })
  };
}

async function writeDebugArtifact(
  input: CollectorInput,
  result: CollectorResult,
  evidence: JalanExtractionEvidence,
  screenshotPath: string | undefined,
  selectedExcerpt: string,
  navigation: JalanPlanNavigationResult,
  planBlockExtraction?: JalanPlanBlockDebugSummary,
  acceptedPricePolicy?: JalanAcceptedPricePolicyDebug
): Promise<void> {
  await writeJalanDebugArtifact({
    runId: input.runId,
    ...(/jalan_(three|five)_property|jalan_budgeted_/u.test(input.jobId ?? "") ? { debugFileName: `${input.propertyId}_${input.stayDate}` } : {}),
    propertyName: input.propertyName,
    propertyUrl: input.propertyUrl ?? "",
    stayDate: input.stayDate,
    status: result.rateSnapshot.availabilityStatus,
    priceJpy: result.rateSnapshot.priceTotalTaxIncluded,
    evidence,
    errorReason: result.rateSnapshot.errorReason ?? null,
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
    selectedExcerpts: [selectedExcerpt],
    navigation: {
      attempted: navigation.attempted,
      strategy: navigation.strategy,
      success: navigation.success,
      beforeUrl: navigation.beforeUrl,
      ...(navigation.afterUrl === undefined ? {} : { afterUrl: navigation.afterUrl }),
      ...(navigation.beforeScreenshotPath === undefined ? {} : { beforeScreenshotPath: navigation.beforeScreenshotPath }),
      ...(navigation.afterScreenshotPath === undefined ? {} : { afterScreenshotPath: navigation.afterScreenshotPath }),
      ...(navigation.errorReason === undefined ? {} : { errorReason: navigation.errorReason }),
      ...(navigation.candidateDiagnostics === undefined ? {} : { candidateDiagnostics: navigation.candidateDiagnostics })
    },
    ...(planBlockExtraction === undefined ? {} : { planBlockExtraction }),
    ...(acceptedPricePolicy === undefined ? {} : { acceptedPricePolicy })
  });
}

function buildAcceptedPricePolicyDebug(
  selection: ReturnType<typeof selectAcceptedJalanPriceCandidate>
): JalanAcceptedPricePolicyDebug {
  const candidate = selection.selectedCandidate;
  return {
    policy: selection.policy,
    safeCandidateCount: selection.safeCandidateCount,
    rejectedCandidateCount: selection.rejectedCandidateCount,
    ...(selection.selectedIndex === undefined ? {} : { selectedIndex: selection.selectedIndex }),
    ...(candidate?.priceValue === undefined ? {} : { selectedPrice: candidate.priceValue }),
    ...(candidate?.priceText === undefined ? {} : { selectedPriceText: candidate.priceText }),
    ...(candidate?.planName === undefined ? {} : { selectedPlanName: candidate.planName }),
    ...(candidate?.roomName === undefined ? {} : { selectedRoomName: candidate.roomName }),
    reason: selection.reason
  };
}

function buildJalanAttemptUrl(input: CollectorInput): string {
  const url = new URL(input.propertyUrl ?? "");
  const [year, month, day] = input.stayDate.split("-");

  if (year !== undefined && month !== undefined && day !== undefined) {
    url.searchParams.set("stayYear", year);
    url.searchParams.set("stayMonth", month);
    url.searchParams.set("stayDay", day);
  }
  url.searchParams.set("stayCount", String(input.nights));
  url.searchParams.set("roomCrack", `${input.adults ?? input.guests}00000`);

  return url.toString();
}

function urlHasPrototypeStayCondition(pageUrl: string, input: CollectorInput): boolean {
  const [year, month, day] = input.stayDate.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }

  try {
    const url = new URL(pageUrl);
    return (
      url.searchParams.get("stayYear") === year &&
      url.searchParams.get("stayMonth") === month &&
      url.searchParams.get("stayDay") === day &&
      url.searchParams.get("stayCount") === String(input.nights) &&
      (url.searchParams.get("roomCrack") ?? "").startsWith(String(input.adults ?? input.guests))
    );
  } catch {
    return false;
  }
}
