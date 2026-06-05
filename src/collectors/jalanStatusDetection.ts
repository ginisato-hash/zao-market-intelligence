import type { AvailabilityStatus } from "../domain/types";

export interface JalanStatusDetection {
  status: AvailabilityStatus;
  errorReason?: string;
}

const BLOCKED_PATTERNS = [/captcha/i, /アクセスが集中/u, /不正なアクセス/u, /bot/i, /ただいまアクセス/u];
const SOLD_OUT_PATTERNS = [
  /満室/u,
  /空室なし/u,
  /予約できません/u,
  /受付終了/u,
  /予約受付を停止/u,
  /ご利用できるプラン(?:が|は)?(?:ありません|ございません|ない)/u
];
const NOT_LISTED_PATTERNS = [/プランなし/u, /該当なし/u, /条件に一致/u, /見つかりません/u, /掲載されていません/u];

export function detectJalanStatus(text: string): JalanStatusDetection {
  if (matchesAny(text, BLOCKED_PATTERNS)) {
    return { status: "failed", errorReason: "Jalan page appears blocked or challenged access." };
  }

  if (matchesAny(text, SOLD_OUT_PATTERNS)) {
    return { status: "sold_out" };
  }

  if (matchesAny(text, NOT_LISTED_PATTERNS)) {
    return { status: "not_listed" };
  }

  return { status: "failed", errorReason: "Jalan status could not be determined conservatively." };
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}
