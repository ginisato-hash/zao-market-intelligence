import type { Page } from "playwright";

export interface RawJalanCandidate {
  index?: number;
  tagName: string;
  text: string;
  href?: string | null;
  role?: string | null;
  type?: string | null;
  id?: string | null;
  className?: string | null;
  nearbyText?: string | null;
}

export interface JalanLinkCandidate {
  index: number;
  tagName: string;
  text: string;
  href: string | null;
  role: string | null;
  type: string | null;
  id: string | null;
  className: string | null;
  nearbyText: string | null;
  sameOriginJalan: boolean;
  pathAllowed: boolean;
  pathDisallowed: boolean;
  allowReason?: string;
  rejectReason?: string;
  score: number;
}

export interface RejectedJalanCandidateExample {
  text: string;
  href: string | null;
  reason: string;
}

export interface JalanCandidateDiagnostics {
  candidateCount: number;
  rejectedCandidateCount: number;
  chosenCandidateText?: string;
  chosenCandidateHref?: string | null;
  chosenCandidateReason?: string;
  rejectedDisallowedExamples: RejectedJalanCandidateExample[];
  finalNavigationDecision: "chosen" | "not_attempted";
}

const DENIED_URL_PATTERN = /(\/doc\/|howto|help|login|member|review|kuchikomi|faq|campaign|coupon|photo|map|access)/iu;
const DENIED_TEXT_PATTERN = /(ヘルプ|ログイン|会員|クチコミ|口コミ|フォト|写真|地図|アクセス|問い合わせ|キャンペーン|クーポン|予約方法|使い方)/u;
const PLAN_URL_PATTERN = /(\/plan\/?|plan|stay|search|reserve|booking|yado)/iu;
const PLAN_TEXT_PATTERN = /(宿泊プラン|料金・宿泊プラン|空室検索|空室検索・予約|予約する|このプラン|再検索|宿泊予約|プラン一覧)/u;
const SEARCH_FORM_TEXT_PATTERN = /(再検索|検索)/u;
const SEARCH_FORM_CONTEXT_PATTERN = /(チェックイン|チェックアウト|宿泊日|部屋数|人数|大人|泊)/u;

export async function collectJalanLinkCandidates(page: Page, currentUrl: string): Promise<JalanLinkCandidate[]> {
  const rawCandidates = await page.locator("a, button, input[type='submit'], input[type='button']").evaluateAll((elements) =>
    elements.slice(0, 120).map((element, index) => {
      const htmlElement = element as HTMLElement;
      const anchor = element instanceof HTMLAnchorElement ? element : null;
      const input = element instanceof HTMLInputElement ? element : null;
      const nearbyText = htmlElement.closest("section, form, div, li, td, tr")?.textContent ?? "";

      return {
        index,
        tagName: element.tagName.toLowerCase(),
        text: (input?.value || htmlElement.innerText || htmlElement.textContent || "").trim(),
        href: anchor?.getAttribute("href") ?? null,
        role: htmlElement.getAttribute("role"),
        type: input?.type ?? htmlElement.getAttribute("type"),
        id: htmlElement.id || null,
        className: typeof htmlElement.className === "string" ? htmlElement.className : null,
        nearbyText: nearbyText.trim().slice(0, 300)
      };
    })
  );

  return rawCandidates.map((candidate) => inspectJalanCandidate(candidate, currentUrl));
}

export function inspectJalanCandidate(raw: RawJalanCandidate, currentUrl: string): JalanLinkCandidate {
  const index = raw.index ?? 0;
  const text = normalize(raw.text);
  const href = raw.href?.trim() === "" ? null : raw.href ?? null;
  const nearbyText = raw.nearbyText === undefined || raw.nearbyText === null ? null : normalize(raw.nearbyText);
  const target = parseSameOriginJalanUrl(href, currentUrl);
  const textBlob = `${text} ${nearbyText ?? ""} ${raw.id ?? ""} ${raw.className ?? ""}`;
  const pathText = target?.pathname ?? href ?? "";
  const pathDisallowed = DENIED_URL_PATTERN.test(pathText) || DENIED_TEXT_PATTERN.test(textBlob);
  const allow = getAllowReason({
    tagName: raw.tagName,
    text,
    href,
    targetPath: target?.pathname ?? "",
    targetSearch: target?.search ?? "",
    type: raw.type ?? null,
    nearbyText
  });

  const candidate: JalanLinkCandidate = {
    index,
    tagName: raw.tagName.toLowerCase(),
    text,
    href,
    role: raw.role ?? null,
    type: raw.type ?? null,
    id: raw.id ?? null,
    className: raw.className ?? null,
    nearbyText,
    sameOriginJalan: target !== null || href === null,
    pathAllowed: allow.reason !== undefined && !pathDisallowed && (target !== null || allow.allowsButtonWithoutHref),
    pathDisallowed,
    score: pathDisallowed ? 0 : allow.score
  };

  if (allow.reason !== undefined && candidate.pathAllowed) {
    candidate.allowReason = allow.reason;
  }
  if (pathDisallowed) {
    candidate.rejectReason = "disallowed_url_or_text";
  } else if (!candidate.sameOriginJalan) {
    candidate.rejectReason = "not_same_origin_jalan";
  } else if (allow.reason === undefined) {
    candidate.rejectReason = "not_plan_or_reservation_related";
  } else if (!candidate.pathAllowed) {
    candidate.rejectReason = "href_required_for_non_selector_candidate";
  }

  return candidate;
}

export function chooseJalanNavigationCandidate(candidates: JalanLinkCandidate[]): {
  chosen: JalanLinkCandidate | null;
  diagnostics: JalanCandidateDiagnostics;
} {
  const rejected = candidates.filter((candidate) => candidate.rejectReason !== undefined);
  const allowed = candidates
    .filter((candidate) => candidate.pathAllowed && !candidate.pathDisallowed && candidate.sameOriginJalan)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const chosen = allowed[0] ?? null;
  const diagnostics: JalanCandidateDiagnostics = {
    candidateCount: candidates.length,
    rejectedCandidateCount: rejected.length,
    rejectedDisallowedExamples: rejected
      .filter((candidate) => candidate.pathDisallowed || candidate.href?.includes("/doc/") === true)
      .slice(0, 5)
      .map((candidate) => ({
        text: candidate.text,
        href: candidate.href,
        reason: candidate.rejectReason ?? "rejected"
      })),
    finalNavigationDecision: chosen === null ? "not_attempted" : "chosen"
  };

  if (chosen !== null) {
    diagnostics.chosenCandidateText = chosen.text;
    diagnostics.chosenCandidateHref = chosen.href;
    if (chosen.allowReason !== undefined) {
      diagnostics.chosenCandidateReason = chosen.allowReason;
    }
  }

  return { chosen, diagnostics };
}

export function isSafeJalanPlanNavigationTarget(text: string, href: string | null, currentUrl: string): boolean {
  return inspectJalanCandidate({ tagName: "a", text, href }, currentUrl).pathAllowed;
}

function getAllowReason(input: {
  tagName: string;
  text: string;
  href: string | null;
  targetPath: string;
  targetSearch: string;
  type: string | null;
  nearbyText: string | null;
}): { reason?: string; score: number; allowsButtonWithoutHref: boolean } {
  const target = `${input.targetPath} ${input.targetSearch}`;
  if (PLAN_URL_PATTERN.test(target) && PLAN_TEXT_PATTERN.test(input.text)) {
    return { reason: "same_origin_plan_or_reservation_url", score: 100, allowsButtonWithoutHref: false };
  }

  if (PLAN_URL_PATTERN.test(target)) {
    return { reason: "same_origin_plan_url", score: 80, allowsButtonWithoutHref: false };
  }

  if (input.targetSearch.includes("stayYear") && PLAN_TEXT_PATTERN.test(input.text)) {
    return { reason: "date_conditioned_url", score: 75, allowsButtonWithoutHref: false };
  }

  const isButton = input.tagName.toLowerCase() === "button" || input.tagName.toLowerCase() === "input";
  const isSubmit = input.type === null || /^(submit|button)$/iu.test(input.type);
  if (
    isButton &&
    isSubmit &&
    input.href === null &&
    SEARCH_FORM_TEXT_PATTERN.test(input.text) &&
    SEARCH_FORM_CONTEXT_PATTERN.test(input.nearbyText ?? "")
  ) {
    return { reason: "selector_specific_search_form_button", score: 70, allowsButtonWithoutHref: true };
  }

  if (input.href !== null && PLAN_TEXT_PATTERN.test(input.text)) {
    return { reason: "plan_or_reservation_text", score: 50, allowsButtonWithoutHref: false };
  }

  return { score: 0, allowsButtonWithoutHref: false };
}

function parseSameOriginJalanUrl(href: string | null, currentUrl: string): URL | null {
  if (href === null || href.startsWith("javascript:")) {
    return null;
  }

  try {
    const current = new URL(currentUrl);
    const target = new URL(href, currentUrl);
    if (target.hostname !== current.hostname || !/jalan\.net$/u.test(target.hostname)) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
