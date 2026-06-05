import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RakutenExtractionEvidence } from "./rakutenEvidence";
import type { RakutenFormInspectionResult } from "./rakutenFormInspector";
import type { RakutenSearchConditionSetResult, RakutenSearchInteractionResult } from "./rakutenSearchInteraction";

export interface RakutenAccessStrategy {
  attemptedUrl: string;
  strategy:
    | "overview_url_with_search_click"
    | "overview_url_without_click"
    | "plan_url_404_previous_strategy";
  searchInteraction: {
    attempted: boolean;
    success: boolean;
    strategy: string;
    beforeUrl: string;
    afterUrl?: string;
    errorReason?: string;
    visibleSignals?: string[];
    searchConditions?: RakutenSearchConditionSetResult;
  };
  reachedPlanResults: boolean;
  finalUrl: string;
  rejectionReason?: string;
}

export function buildAccessStrategy(params: {
  attemptedUrl: string;
  searchInteraction: RakutenSearchInteractionResult;
  reachedPlanResults: boolean;
  finalUrl: string;
  rejectionReason?: string;
}): RakutenAccessStrategy {
  const { searchInteraction } = params;
  const strategy: RakutenAccessStrategy["strategy"] = searchInteraction.attempted
    ? "overview_url_with_search_click"
    : "overview_url_without_click";

  return {
    attemptedUrl: params.attemptedUrl,
    strategy,
    searchInteraction: {
      attempted: searchInteraction.attempted,
      success: searchInteraction.success,
      strategy: searchInteraction.strategy,
      beforeUrl: searchInteraction.beforeUrl,
      ...(searchInteraction.afterUrl !== undefined ? { afterUrl: searchInteraction.afterUrl } : {}),
      ...(searchInteraction.errorReason !== undefined ? { errorReason: searchInteraction.errorReason } : {}),
      ...(searchInteraction.visibleSignals !== undefined ? { visibleSignals: searchInteraction.visibleSignals } : {}),
      ...(searchInteraction.searchConditions !== undefined ? { searchConditions: searchInteraction.searchConditions } : {})
    },
    reachedPlanResults: params.reachedPlanResults,
    finalUrl: params.finalUrl,
    ...(params.rejectionReason !== undefined ? { rejectionReason: params.rejectionReason } : {})
  };
}

export interface RakutenDebugArtifactInput {
  runId: string;
  propertyName: string;
  propertyUrl: string;
  attemptUrl: string;
  stayDate: string;
  status: string;
  evidence: RakutenExtractionEvidence;
  selectedPrice?: number | null;
  errorReason?: string | null;
  screenshotPath?: string;
  bodyTextExcerpt?: string;
  rakutenAccessStrategy?: RakutenAccessStrategy;
  rakutenFormInspection?: RakutenFormInspectionResult;
}

export async function writeRakutenDebugArtifact(input: RakutenDebugArtifactInput): Promise<string> {
  const path = join(".data/debug/rakuten", input.runId, `${input.stayDate}.json`);
  await mkdir(join(".data/debug/rakuten", input.runId), { recursive: true });
  await writeFile(path, JSON.stringify(input, null, 2), "utf8");
  return path;
}
