// AUTO-RUNNER-CHATGPT-UPLOAD02 — GitHub Release publish helpers (pure).
//
// This module is pure: no I/O, no network, no gh calls, no DB writes.
// The companion script does all subprocess/filesystem work and calls these
// functions for decision logic, release body rendering, and output formatting.

export const RELEASE_TAG = "chatgpt-db-latest";
export const RELEASE_TITLE = "ZMI ChatGPT DB Latest";
export const ASSET_NAME = "zmi_chatgpt_upload_latest.zip";

export type PublishDecision =
  | "chatgpt_db_publish_ready"
  | "chatgpt_db_publish_not_ready"
  | "chatgpt_db_publish_gh_missing"
  | "chatgpt_db_publish_zip_missing";

export interface PublishContext {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  zipPath: string;
  zipSizeBytes: number;
  releaseExists: boolean;
}

export function decidePublish(ctx: PublishContext): PublishDecision {
  if (!ctx.ghInstalled || !ctx.ghAuthenticated) return "chatgpt_db_publish_gh_missing";
  if (!ctx.zipPath || ctx.zipSizeBytes <= 0) return "chatgpt_db_publish_zip_missing";
  return "chatgpt_db_publish_ready";
}

export function buildReleaseBody(historyRows: number, collectedDate: string | null): string {
  const dateNote = collectedDate ? `\nLatest collected date: ${collectedDate}` : "";
  return `# ZMI ChatGPT DB Latest

This release contains the latest ChatGPT upload bundle generated from the always-on Mac.

History rows: ${historyRows}${dateNote}

## Asset

- \`${ASSET_NAME}\`

## Use in ChatGPT

\`\`\`
GitHub Release \`${RELEASE_TAG}\` の asset \`${ASSET_NAME}\` を取得して読み込んでください。
対象施設: 【三浦屋 / 喜らく / その他】
対象期間: 【YYYY-MM-DD〜YYYY-MM-DD】
出力: Notion貼り付け用の市場分析レポートのみ。CSVは不要。
推測補完は禁止。取得不可データはCとして扱ってください。
\`\`\`

## Safety

- history CSV is canonical
- SQLite is a mirror
- do not infer unavailable data
- do not produce PMS files unless explicitly requested
- basis_caution / manual_review rows: treat with care, do not promote excluded rows
- intraday rows (row_id contains \`::intraday::\`): use the most recent observation
`;
}

export function renderPublishSummary(ctx: PublishContext, decision: PublishDecision, releaseUrl: string, assetUrl: string): string {
  return [
    `decision=${decision}`,
    `release_tag=${RELEASE_TAG}`,
    `release_url=${releaseUrl}`,
    `asset_name=${ASSET_NAME}`,
    `asset_url=${assetUrl}`,
    `local_zip=${ctx.zipPath}`,
    `zip_size_bytes=${ctx.zipSizeBytes}`
  ].join("\n");
}
