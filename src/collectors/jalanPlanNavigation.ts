import type { Page } from "playwright";
import type { CollectorInput } from "../domain/types";
import type { ScreenshotStorage } from "../services/screenshotStorage";
import { createScreenshotKey } from "../utils/screenshotKey";
import { createId } from "../utils/ids";
import {
  chooseJalanNavigationCandidate,
  collectJalanLinkCandidates,
  isSafeJalanPlanNavigationTarget,
  type JalanCandidateDiagnostics
} from "./jalanLinkInspector";

export type JalanPlanNavigationStrategy =
  | "click_selected_date"
  | "click_nearby_plan_link"
  | "follow_visible_plan_link"
  | "not_attempted";

export interface JalanPlanNavigationResult {
  attempted: boolean;
  strategy: JalanPlanNavigationStrategy;
  success: boolean;
  beforeUrl: string;
  afterUrl?: string;
  beforeScreenshotPath?: string;
  afterScreenshotPath?: string;
  evidenceText?: string;
  errorReason?: string;
  candidateDiagnostics?: JalanCandidateDiagnostics;
}
export { isSafeJalanPlanNavigationTarget };

export async function attemptJalanPlanNavigation(input: {
  page: Page;
  collectorInput: CollectorInput;
  screenshotStorage: ScreenshotStorage;
}): Promise<JalanPlanNavigationResult> {
  const beforeUrl = input.page.url();
  const beforeScreenshotPath = await captureNavigationScreenshot(input.page, input.collectorInput, input.screenshotStorage, "before");
  const candidates = await collectJalanLinkCandidates(input.page, beforeUrl);
  const { chosen, diagnostics } = chooseJalanNavigationCandidate(candidates);

  if (chosen === null) {
    return {
      attempted: false,
      strategy: "not_attempted",
      success: false,
      beforeUrl,
      beforeScreenshotPath,
      errorReason: "plan_navigation_target_unclear",
      candidateDiagnostics: diagnostics
    };
  }

  try {
    const candidate = input.page.locator("a, button, input[type='submit'], input[type='button']").nth(chosen.index);
    await Promise.all([
      input.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined),
      candidate.click()
    ]);
    await input.page.waitForTimeout(1_000);
    const afterScreenshotPath = await captureNavigationScreenshot(input.page, input.collectorInput, input.screenshotStorage, "after");
    const evidenceText = (await input.page.locator("body").innerText({ timeout: 5_000 })).slice(0, 8_000);
    const afterUrl = input.page.url();
    const selectedDateSurvived = hasSelectedDateContext(afterUrl, evidenceText, input.collectorInput.stayDate);

    return {
      attempted: true,
      strategy: chosen.href === null ? "click_nearby_plan_link" : "follow_visible_plan_link",
      success: afterUrl !== beforeUrl && selectedDateSurvived,
      beforeUrl,
      afterUrl,
      beforeScreenshotPath,
      afterScreenshotPath,
      evidenceText,
      ...(selectedDateSurvived ? {} : { errorReason: "selected_date_not_preserved" }),
      candidateDiagnostics: diagnostics
    };
  } catch (error) {
    return {
      attempted: true,
      strategy: chosen.href === null ? "click_nearby_plan_link" : "follow_visible_plan_link",
      success: false,
      beforeUrl,
      afterUrl: input.page.url(),
      beforeScreenshotPath,
      errorReason: error instanceof Error ? `plan_navigation_failed: ${error.message}` : "plan_navigation_failed",
      candidateDiagnostics: diagnostics
    };
  }
}

async function captureNavigationScreenshot(
  page: Page,
  input: CollectorInput,
  storage: ScreenshotStorage,
  phase: "before" | "after"
): Promise<string> {
  const body = await page.screenshot({ fullPage: true });
  const key = createScreenshotKey({
    capturedAt: new Date(),
    runId: input.runId,
    propertyId: input.propertyId,
    ota: "jalan",
    stayDate: input.stayDate,
    jobId: `${input.jobId ?? createId("jalan_job")}_${phase}`
  });
  const stored = await storage.putObject({ key, contentType: "image/png", body });
  return stored.path;
}

function hasSelectedDateContext(url: string, evidenceText: string, stayDate: string): boolean {
  const [year, month, day] = stayDate.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }

  const parsedUrl = new URL(url);
  if (
    parsedUrl.searchParams.get("stayYear") === year &&
    parsedUrl.searchParams.get("stayMonth") === month &&
    parsedUrl.searchParams.get("stayDay") === day
  ) {
    return true;
  }

  const numericMonth = String(Number(month));
  const numericDay = String(Number(day));
  return (
    evidenceText.includes(stayDate) ||
    evidenceText.includes(`${year}年${numericMonth}月${numericDay}日`) ||
    evidenceText.includes(`${numericMonth}月${numericDay}日`)
  );
}
