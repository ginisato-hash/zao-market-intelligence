import type { AvailabilityStatus } from "../domain/types";

export interface RakutenStatusDetection {
  status: AvailabilityStatus;
  errorReason?: string;
}

const BLOCKED_PATTERN = /(captcha|CAPTCHA|アクセスが集中|不正なアクセス|invalid access|しばらく時間をおいて|ロボットではありません)/iu;
const SOLD_OUT_PATTERN = /(満室|空室なし|受付終了)/u;
const NOT_LISTED_PATTERN = /(プランなし|該当なし|条件に合う(?:宿泊)?プラン(?:は|が)?(?:ありません|見つかりません))/u;
// Matches the hotel overview/search-form page — price-range filter label only appears there, not on plan results
const OVERVIEW_FORM_PATTERN = /合計料金\s*※1部屋あたりの税込金額/u;
// Rakuten standard 404 page text
const PLAN_404_PATTERN = /(404 Not Found|指定されたページが見つかりません)/u;

export function detectRakutenStatus(text: string): RakutenStatusDetection {
  if (BLOCKED_PATTERN.test(text)) {
    return { status: "failed", errorReason: "rakuten_access_blocked_or_captcha" };
  }
  if (PLAN_404_PATTERN.test(text)) {
    return { status: "failed", errorReason: "rakuten_plan_url_404_not_found" };
  }
  if (SOLD_OUT_PATTERN.test(text)) {
    return { status: "sold_out" };
  }
  if (NOT_LISTED_PATTERN.test(text)) {
    return { status: "not_listed" };
  }
  if (OVERVIEW_FORM_PATTERN.test(text)) {
    return { status: "failed", errorReason: "rakuten_overview_page_no_plan_results" };
  }
  return { status: "failed", errorReason: "rakuten_status_unclear" };
}
