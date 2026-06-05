import {
  normalizePropertyName,
  resolveCanonicalPropertyNameDetailed,
  type PropertyAlias
} from "./propertyAliasResolver";
import type { ExtractedSourceListing, SourceListingSource } from "./extractZaoSourceListings";

/**
 * Phase 46.6X Deliverable 3 — build the Zao Onsen property universe from the two
 * source listing pages (Jalan ∪ Rakuten), canonicalizing alias variants.
 *
 * Per the work order's "Filter to Zao Onsen only" decision, listings the Jalan
 * keyword search surfaced that are NOT Zao Onsen lodging (Yamagata-station
 * business hotels, other onsen areas, Tendo/Nanyo) are EXCLUDED from the
 * universe and recorded with a reason. Mock/test fixtures are hard-rejected.
 * Alias variants of the same physical hotel are merged; when a merge is only
 * inferred (not backed by the confirmed alias registry / DB), the row is flagged
 * canonicalization_status="needs_review" rather than merged silently.
 */

export const MOCK_PATTERN = /mock|test|fixture|dummy|sample/iu;

export const EXPECTED_ZAO_ANCHORS = [
  "蔵王国際ホテル",
  "蔵王四季のホテル",
  "深山荘 高見屋",
  "名湯リゾート ルーセント",
  "JURIN",
  "BED'n ONSEN HAMMOND",
  "名湯舎 創",
  "ホテル喜らく",
  "吉田屋",
  "たかみや瑠璃倶楽",
  "ONSEN & STAY OAKHILL",
  "三浦屋"
] as const;

const FORCED_ALIASES: PropertyAlias[] = [
  {
    canonical_property_name: "最上高湯 善七乃湯",
    aliases: [
      "善七乃湯・oohira HOTEL",
      "蔵王温泉 善七乃湯・oohira HOTEL",
      "最上高湯 善七乃湯（旧：蔵王温泉 大平ホテル）",
      "蔵王温泉 最上高湯 善七乃湯（旧：蔵王温泉 大平ホテル）",
      "蔵王温泉 大平ホテル",
      "oohira HOTEL"
    ],
    status: "confirmed",
    notes: "Phase 46.7X forced merge per Gemini QA."
  }
];

const ACCEPTED_CANONICAL_PROPERTY_NAMES = new Set([
  "YuiLocalZao",
  "ZAO BASE",
  "ユニテ蔵王ジョーニダ・リゾート"
]);

const GEOGRAPHIC_BOUNDARY_EXCLUSIONS = new Set([
  "蔵王エコー山荘",
  "蔵王ライザウッディロッジ"
]);

/** Tokens that mark a listing as clearly OUTSIDE Zao Onsen (off-market). */
const OFF_MARKET_TOKENS = [
  "山形駅",
  "天童",
  "かみのやま",
  "上山",
  "小野川",
  "熊野大社",
  "南陽",
  "七日町",
  "あこや",
  "山形国際",
  "山形南",
  "山形県職員",
  "河北",
  "寒河江",
  "いずくら"
];

export type CanonicalizationStatus = "canonical" | "needs_review";

export type UniverseSource = SourceListingSource | "local_operator" | "local_known";

export type ExclusionReason =
  | "outside_zao_area"
  | "station_area_noise"
  | "other_onsen_area"
  | "duplicate_alias_merged"
  | "ambiguous_location"
  | "mock_or_test"
  | "non_lodging"
  | "unknown";

export interface UniverseSourceRef {
  property_url: string;
  source_property_id: string;
}

export interface UniverseRow {
  canonical_property_name: string;
  aliases: string[];
  sources_present: UniverseSource[];
  jalan: UniverseSourceRef | null;
  rakuten: UniverseSourceRef | null;
  local: LocalPropertyExtension | null;
  canonicalization_status: CanonicalizationStatus;
  evidence_note: string;
}

export interface ExcludedListing {
  source: SourceListingSource;
  property_name_raw: string;
  property_url: string | null;
  source_property_id: string | null;
  reason: ExclusionReason;
  note: string;
}

export interface ExcludedListingAudit {
  source: SourceListingSource;
  propertyNameRaw: string;
  propertyUrl: string | null;
  sourcePropertyId: string | null;
  exclusionReason: ExclusionReason;
  evidenceNote: string;
}

export interface SuspectedDuplicate {
  canonical_names: string[];
  shared_token: string;
  note: string;
}

export interface DbDiff {
  in_sources_not_in_db: string[];
  in_db_not_in_sources: string[];
}

export interface AliasDecision {
  canonical_property_name: string;
  basis: "confirmed_alias" | "db_match" | "cross_source_exact" | "cross_source_inferred" | "single_source";
  merged_raw_names: string[];
  note: string;
}

export interface LocalPropertyExtension {
  property_name: string;
  source: "local_operator" | "local_known";
  canonicalization_status: CanonicalizationStatus;
  evidence_note: string;
}

export interface AnchorCheck {
  anchor: string;
  present: boolean;
  canonical_property_name: string | null;
  sources_present: UniverseSource[];
  canonicalization_status: CanonicalizationStatus | null;
}

export interface BuildUniverseResult {
  universe: UniverseRow[];
  excluded: ExcludedListing[];
  excludedAudit: ExcludedListingAudit[];
  suspectedDuplicates: SuspectedDuplicate[];
  dbDiff: DbDiff;
  aliasDecisions: AliasDecision[];
  anchorChecks: AnchorCheck[];
  errors: string[];
  stats: {
    listingsIn: number;
    universeCount: number;
    excludedMock: number;
    excludedOffMarket: number;
    excludedAmbiguous: number;
    canonicalCount: number;
    needsReviewCount: number;
  };
}

const GENERIC_TOKENS = new Set([
  "ホテル",
  "のホテル",
  "森のホテル",
  "旅館",
  "ペンション",
  "リゾート",
  "の宿",
  "料理の宿",
  "温泉",
  "onsen",
  "stay",
  "resort",
  "蔵王温泉",
  "蔵王"
]);

/** Builder-internal match key: shared normalization + light kana folding. */
function matchKey(name: string): string {
  return normalizePropertyName(name)
    .replace(/[ぢ]/gu, "じ")
    .replace(/[ヂ]/gu, "ジ")
    .replace(/[づ]/gu, "ず")
    .replace(/[ヅ]/gu, "ズ");
}

function stripZaoPrefix(key: string): string {
  return key.replace(/^蔵王温泉/u, "");
}

function keyOf(name: string): string {
  return stripZaoPrefix(matchKey(name));
}

/** Faithful display name with only the leading onsen-area label removed. */
function cleanDisplay(rawName: string): string {
  return rawName.replace(/^蔵王温泉[\s　]*/u, "").trim();
}

function containsMatch(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  const min = Math.min(a.length, b.length);
  return min >= 5 && (a.includes(b) || b.includes(a));
}

function longestCommonSubstring(a: string, b: string): string {
  let best = "";
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j <= a.length; j++) {
      const sub = a.slice(i, j);
      if (sub.length <= best.length) {
        continue;
      }
      if (b.includes(sub)) {
        best = sub;
      }
    }
  }
  return best;
}

interface ClassifiedListing {
  listing: ExtractedSourceListing;
  membership: "member" | "off_market" | "ambiguous";
  canonical: string;
  basis: AliasDecision["basis"];
}

function classify(
  listing: ExtractedSourceListing,
  aliases: PropertyAlias[],
  dbNames: string[]
): ClassifiedListing {
  const raw = listing.propertyNameRaw;
  const nrm = normalizePropertyName(raw);

  // 1) Confirmed-alias resolution (handles prefixed variants in the registry).
  //    Try both the raw name and the de-prefixed display name so that source
  //    variants carrying a leading "蔵王温泉" still match registry aliases that
  //    were recorded without the prefix.
  for (const candidate of [raw, cleanDisplay(raw)]) {
    const aliasDetailed = resolveCanonicalPropertyNameDetailed(candidate, aliases);
    if (aliasDetailed.status === "resolved") {
      return { listing, membership: "member", canonical: aliasDetailed.canonicalName, basis: "confirmed_alias" };
    }
    if (aliasDetailed.status === "ambiguous" && aliasDetailed.matchedAliases.length > 0) {
      return {
        listing,
        membership: "member",
        canonical: aliasDetailed.matchedAliases[0]!.canonical_property_name,
        basis: "confirmed_alias"
      };
    }
  }

  // 2) DB match (exact key or contains) — DB properties are all Zao Onsen.
  const k = keyOf(raw);
  const dbHit = dbNames.find((name) => {
    const dk = keyOf(name);
    return dk === k || containsMatch(dk, k);
  });
  if (dbHit) {
    return { listing, membership: "member", canonical: dbHit, basis: "db_match" };
  }

  // 3) Zao-Onsen membership signals for un-registered listings.
  const display = cleanDisplay(raw);
  const isMember =
    listing.source === "rakuten" || // Rakuten onsen page is definitionally Zao Onsen
    nrm.startsWith("蔵王温泉") ||
    /蔵王/u.test(raw) ||
    /zao/iu.test(raw);
  if (isMember) {
    return { listing, membership: "member", canonical: display, basis: "single_source" };
  }
  if (OFF_MARKET_TOKENS.some((t) => raw.includes(t))) {
    return { listing, membership: "off_market", canonical: display, basis: "single_source" };
  }
  return { listing, membership: "ambiguous", canonical: display, basis: "single_source" };
}

function reasonNote(reason: ExclusionReason, raw: string): string {
  switch (reason) {
    case "mock_or_test":
      return `Excluded: "${raw}" matches mock/test fixture pattern — never allowed in the Zao Onsen market universe.`;
    case "station_area_noise":
    case "outside_zao_area":
    case "other_onsen_area":
      return `Excluded: "${raw}" is outside Zao Onsen (Yamagata-area keyword noise) per the "Zao Onsen only" filter decision.`;
    case "ambiguous_location":
      return `Excluded pending review: "${raw}" surfaced by the Jalan keyword search but carries no clear Zao Onsen signal — human should confirm whether to re-add.`;
    case "duplicate_alias_merged":
      return `Excluded from standalone universe: "${raw}" was merged into a canonical property as an alias.`;
    case "non_lodging":
      return `Excluded: "${raw}" appears not to be a lodging property.`;
    case "unknown":
      return `Excluded: "${raw}" requires further review.`;
  }
}

export function buildZaoPropertyUniverse(
  listings: ExtractedSourceListing[],
  aliases: PropertyAlias[],
  dbNames: string[],
  localExtensions: LocalPropertyExtension[] = []
): BuildUniverseResult {
  const excluded: ExcludedListing[] = [];
  const errors: string[] = [];
  const allAliases = [...FORCED_ALIASES, ...aliases];

  // Hard mock/test rejection first.
  const nonMock: ExtractedSourceListing[] = [];
  for (const l of listings) {
    if (MOCK_PATTERN.test(l.propertyNameRaw) || (l.sourcePropertyId && MOCK_PATTERN.test(l.sourcePropertyId))) {
      excluded.push({
        source: l.source,
        property_name_raw: l.propertyNameRaw,
        property_url: l.propertyUrl,
        source_property_id: l.sourcePropertyId,
        reason: "mock_or_test",
        note: reasonNote("mock_or_test", l.propertyNameRaw)
      });
    } else if (isGeographicBoundaryExclusion(l.propertyNameRaw)) {
      excluded.push({
        source: l.source,
        property_name_raw: l.propertyNameRaw,
        property_url: l.propertyUrl,
        source_property_id: l.sourcePropertyId,
        reason: "outside_zao_area",
        note: geographicBoundaryNote(l.propertyNameRaw)
      });
    } else {
      nonMock.push(l);
    }
  }

  // Classify membership + canonical.
  const classified = nonMock.map((l) => classify(l, allAliases, dbNames));

  // Phase 2: promote "ambiguous" listings (typically Jalan rows whose own name
  // lacks a 蔵王 token) when they cross-match a Rakuten-backed member — the
  // Rakuten onsen page is the authoritative Zao Onsen set. The merge is inferred
  // (display names differ), so the resulting row is flagged needs_review.
  const inferredCanonicals = new Set<string>();
  const rakutenMemberKeys = classified
    .filter((c) => c.membership === "member" && c.listing.source === "rakuten")
    .map((c) => ({ key: keyOf(c.canonical), canonical: c.canonical }));
  for (const c of classified) {
    if (c.membership !== "ambiguous") {
      continue;
    }
    const ck = keyOf(c.canonical);
    let hit = rakutenMemberKeys.find((r) => r.key === ck || containsMatch(r.key, ck));
    if (!hit) {
      // Conservative LCS fallback: same physical hotel whose source names differ
      // mid-string (e.g. 泊り処/泊まり処, a 堺屋 prefix). Require a long, non-generic
      // shared run so pensions are not mis-attached to unrelated hotels.
      hit = rakutenMemberKeys.find((r) => {
        const lcs = longestCommonSubstring(r.key, ck);
        return lcs.length >= 6 && !GENERIC_TOKENS.has(lcs);
      });
    }
    if (hit) {
      c.membership = "member";
      c.canonical = hit.canonical;
      inferredCanonicals.add(hit.canonical);
    }
  }

  const members: ClassifiedListing[] = [];
  for (const c of classified) {
    if (c.membership === "member") {
      members.push(c);
    } else {
      excluded.push({
        source: c.listing.source,
        property_name_raw: c.listing.propertyNameRaw,
        property_url: c.listing.propertyUrl,
        source_property_id: c.listing.sourcePropertyId,
        reason: c.membership === "off_market" ? classifyOffMarketReason(c.listing.propertyNameRaw) : "ambiguous_location",
        note: reasonNote(
          c.membership === "off_market" ? classifyOffMarketReason(c.listing.propertyNameRaw) : "ambiguous_location",
          c.listing.propertyNameRaw
        )
      });
    }
  }

  // Group members by canonical name (exact string).
  interface Group {
    canonical: string;
    items: ClassifiedListing[];
    inferredMerge: boolean;
  }
  const groupByCanon = new Map<string, Group>();
  for (const m of members) {
    const g = groupByCanon.get(m.canonical);
    if (g) {
      g.items.push(m);
    } else {
      groupByCanon.set(m.canonical, {
        canonical: m.canonical,
        items: [m],
        inferredMerge: inferredCanonicals.has(m.canonical)
      });
    }
  }
  let groups = [...groupByCanon.values()];

  const localByCanonical = new Map<string, LocalPropertyExtension>();
  for (const local of localExtensions) {
    if (MOCK_PATTERN.test(local.property_name)) {
      excluded.push({
        source: "jalan",
        property_name_raw: local.property_name,
        property_url: null,
        source_property_id: null,
        reason: "mock_or_test",
        note: reasonNote("mock_or_test", local.property_name)
      });
      continue;
    }
    const localCanonical = resolveCanonicalPropertyNameDetailed(local.property_name, allAliases);
    const canonical =
      localCanonical.status === "resolved" ? localCanonical.canonicalName : local.property_name;
    localByCanonical.set(canonical, { ...local, property_name: canonical });
    if (!groupByCanon.has(canonical)) {
      groupByCanon.set(canonical, { canonical, items: [], inferredMerge: false });
    }
  }
  groups = [...groupByCanon.values()];

  // Pass 2: merge single_source groups whose keys are containment-equivalent
  // (different display names, same physical hotel) — flag as inferred.
  const merged: Group[] = [];
  for (const g of groups) {
    const allSingle = g.items.every((i) => i.basis === "single_source");
    let target: Group | undefined;
    if (allSingle) {
      target = merged.find(
        (t) => t.items.every((i) => i.basis === "single_source") && containsMatch(keyOf(t.canonical), keyOf(g.canonical))
      );
    }
    if (target) {
      target.items.push(...g.items);
      target.inferredMerge = true;
      // Prefer the longer / Rakuten-corroborated display as canonical.
      const rakName = target.items.find((i) => i.listing.source === "rakuten")?.canonical;
      target.canonical = rakName ?? (g.canonical.length > target.canonical.length ? g.canonical : target.canonical);
    } else {
      merged.push({ ...g, items: [...g.items] });
    }
  }
  groups = merged;

  // Pass 3 (report only): suspected duplicates not auto-merged.
  const suspectedDuplicates: SuspectedDuplicate[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = keyOf(groups[i]!.canonical);
      const b = keyOf(groups[j]!.canonical);
      if (containsMatch(a, b)) {
        continue; // already would have merged
      }
      const lcs = longestCommonSubstring(a, b);
      if (lcs.length >= 4 && !GENERIC_TOKENS.has(lcs)) {
        suspectedDuplicates.push({
          canonical_names: [groups[i]!.canonical, groups[j]!.canonical],
          shared_token: lcs,
          note: `Possible same physical hotel across sources (shared token "${lcs}"). Not auto-merged — human review required.`
        });
      }
    }
  }
  const suspectInvolved = new Set(suspectedDuplicates.flatMap((s) => s.canonical_names));

  // Build universe rows.
  const aliasDecisions: AliasDecision[] = [];
  const universe: UniverseRow[] = groups
    .map((g) => {
      const jalanItem = g.items.find((i) => i.listing.source === "jalan");
      const rakutenItem = g.items.find((i) => i.listing.source === "rakuten");
      const sources_present = [
        ...new Set([
          ...g.items.map((i) => i.listing.source),
          ...(localByCanonical.has(g.canonical) ? [localByCanonical.get(g.canonical)!.source] : [])
        ])
      ] as UniverseSource[];

      const jalan: UniverseSourceRef | null =
        jalanItem && jalanItem.listing.propertyUrl && jalanItem.listing.sourcePropertyId
          ? {
              property_url: jalanItem.listing.propertyUrl,
              source_property_id: jalanItem.listing.sourcePropertyId
            }
          : null;
      const rakuten: UniverseSourceRef | null =
        rakutenItem && rakutenItem.listing.propertyUrl && rakutenItem.listing.sourcePropertyId
          ? {
              property_url: rakutenItem.listing.propertyUrl,
              source_property_id: rakutenItem.listing.sourcePropertyId
            }
          : null;
      const local = localByCanonical.get(g.canonical) ?? null;

      const basis: AliasDecision["basis"] = g.items.some((i) => i.basis === "confirmed_alias")
        ? "confirmed_alias"
        : g.items.some((i) => i.basis === "db_match")
          ? "db_match"
          : g.inferredMerge
            ? "cross_source_inferred"
          : g.items.map((i) => i.listing.source).filter((s, idx, arr) => arr.indexOf(s) === idx).length >= 2
              ? "cross_source_exact"
              : "single_source";

      const rawNames = [...new Set([...g.items.map((i) => i.listing.propertyNameRaw), ...(local ? [local.property_name] : [])])];
      const aliasesOut = rawNames.filter((n) => n !== g.canonical);

      const trustworthy =
        ((basis === "confirmed_alias" || basis === "db_match" || basis === "cross_source_exact") ||
          local?.canonicalization_status === "canonical" ||
          ACCEPTED_CANONICAL_PROPERTY_NAMES.has(g.canonical)) &&
        !suspectInvolved.has(g.canonical);
      const canonicalization_status: CanonicalizationStatus =
        local?.canonicalization_status === "needs_review"
          ? "needs_review"
          : trustworthy
            ? "canonical"
            : "needs_review";

      const evidenceParts = [
        `Canonicalized from ${sources_present.join("+")} via ${basis}.`,
        rawNames.length > 1 ? `Variants: ${rawNames.join(" | ")}.` : `Listing name: ${rawNames[0]}.`
      ];
      if (g.inferredMerge) {
        evidenceParts.push("Cross-source merge inferred (display names differ) — confirm manually.");
      }
      if (suspectInvolved.has(g.canonical)) {
        evidenceParts.push("Flagged as a suspected cross-source duplicate — confirm manually.");
      }
      if (local) {
        evidenceParts.push(`Local extension (${local.source}): ${local.evidence_note}`);
      }
      if (ACCEPTED_CANONICAL_PROPERTY_NAMES.has(g.canonical)) {
        evidenceParts.push("Accepted as canonical Zao Onsen market property by user instruction in Phase 46.8R.");
      }

      aliasDecisions.push({
        canonical_property_name: g.canonical,
        basis,
        merged_raw_names: rawNames,
        note: evidenceParts.join(" ")
      });

      return {
        canonical_property_name: g.canonical,
        aliases: aliasesOut,
        sources_present,
        jalan,
        rakuten,
        local,
        canonicalization_status,
        evidence_note: evidenceParts.join(" ")
      };
    })
    .sort((a, b) => a.canonical_property_name.localeCompare(b.canonical_property_name, "ja"));

  // DB diff.
  const universeKeys = new Map<string, string>();
  for (const row of universe) {
    universeKeys.set(keyOf(row.canonical_property_name), row.canonical_property_name);
    for (const a of row.aliases) {
      universeKeys.set(keyOf(a), row.canonical_property_name);
    }
  }
  const dbKeySet = new Map<string, string>();
  for (const name of dbNames) {
    dbKeySet.set(keyOf(name), name);
  }
  const in_db_not_in_sources = dbNames.filter((name) => {
    const dk = keyOf(name);
    if (universeKeys.has(dk)) {
      return false;
    }
    return ![...universeKeys.keys()].some((uk) => containsMatch(uk, dk));
  });
  const in_sources_not_in_db = universe
    .filter((row) => {
      const uk = keyOf(row.canonical_property_name);
      if (dbKeySet.has(uk)) {
        return false;
      }
      return ![...dbKeySet.keys()].some((dk) => containsMatch(dk, uk));
    })
    .map((row) => row.canonical_property_name);

  // Validation.
  const seenCanon = new Set<string>();
  for (const row of universe) {
    if (seenCanon.has(row.canonical_property_name)) {
      errors.push(`duplicate canonical_property_name: ${row.canonical_property_name}`);
    }
    seenCanon.add(row.canonical_property_name);
    if (MOCK_PATTERN.test(row.canonical_property_name)) {
      errors.push(`mock/test name leaked into universe: ${row.canonical_property_name}`);
    }
  }
  // No duplicate source URL across two different canonicals (unless flagged).
  for (const src of ["jalan", "rakuten"] as const) {
    const urlToCanon = new Map<string, string>();
    for (const row of universe) {
      const ref = row[src];
      if (!ref) {
        continue;
      }
      const prev = urlToCanon.get(ref.property_url);
      if (prev && prev !== row.canonical_property_name && row.canonicalization_status !== "needs_review") {
        errors.push(`duplicate ${src} URL ${ref.property_url} on canonicals "${prev}" and "${row.canonical_property_name}"`);
      } else {
        urlToCanon.set(ref.property_url, row.canonical_property_name);
      }
    }
  }
  // Every member listing maps to exactly one universe row.
  const mappedListings = groups.reduce((sum, g) => sum + g.items.length, 0);
  if (mappedListings !== members.length) {
    errors.push(`listing-mapping mismatch: ${mappedListings} grouped vs ${members.length} members`);
  }

  const anchorChecks = buildAnchorChecks(universe);
  for (const check of anchorChecks) {
    if (!check.present) {
      errors.push(`expected Zao market anchor missing from universe: ${check.anchor}`);
    }
  }
  const zenshichiCanonicals = universe
    .filter((row) => ["善七乃湯・oohira HOTEL", "最上高湯 善七乃湯（旧：蔵王温泉 大平ホテル）"].includes(row.canonical_property_name))
    .map((row) => row.canonical_property_name);
  if (zenshichiCanonicals.length > 0) {
    errors.push(`善七乃湯 variants leaked as standalone canonicals: ${zenshichiCanonicals.join(", ")}`);
  }

  const canonicalCount = universe.filter((r) => r.canonicalization_status === "canonical").length;
  const excludedAudit = excluded.map((e) => ({
    source: e.source,
    propertyNameRaw: e.property_name_raw,
    propertyUrl: e.property_url,
    sourcePropertyId: e.source_property_id,
    exclusionReason: e.reason,
    evidenceNote: e.note
  }));
  return {
    universe,
    excluded,
    excludedAudit,
    suspectedDuplicates,
    dbDiff: { in_sources_not_in_db, in_db_not_in_sources },
    aliasDecisions,
    anchorChecks,
    errors,
    stats: {
      listingsIn: listings.length,
      universeCount: universe.length,
      excludedMock: excluded.filter((e) => e.reason === "mock_or_test").length,
      excludedOffMarket: excluded.filter((e) =>
        ["outside_zao_area", "station_area_noise", "other_onsen_area"].includes(e.reason)
      ).length,
      excludedAmbiguous: excluded.filter((e) => e.reason === "ambiguous_location").length,
      canonicalCount,
      needsReviewCount: universe.length - canonicalCount
    }
  };
}

function classifyOffMarketReason(raw: string): ExclusionReason {
  if (/山形駅|七日町|あこや|山形国際|山形南|山形県職員/u.test(raw)) {
    return "station_area_noise";
  }
  if (/天童|かみのやま|上山|小野川|南陽/u.test(raw)) {
    return "other_onsen_area";
  }
  return "outside_zao_area";
}

function isGeographicBoundaryExclusion(raw: string): boolean {
  const key = keyOf(raw);
  return [...GEOGRAPHIC_BOUNDARY_EXCLUSIONS].some((name) => keyOf(name) === key);
}

function geographicBoundaryNote(raw: string): string {
  return `Excluded: "${raw}" is in the Kaminoyama / Zao Bodaira / Sarakura area; outside Yamagata City Zao Onsen village market.`;
}

function buildAnchorChecks(universe: UniverseRow[]): AnchorCheck[] {
  return EXPECTED_ZAO_ANCHORS.map((anchor) => {
    const ak = keyOf(anchor);
    const hit = universe.find((row) => {
      const keys = [row.canonical_property_name, ...row.aliases].map(keyOf);
      return keys.some((key) => key === ak || containsMatch(key, ak));
    });
    return {
      anchor,
      present: Boolean(hit),
      canonical_property_name: hit?.canonical_property_name ?? null,
      sources_present: hit?.sources_present ?? [],
      canonicalization_status: hit?.canonicalization_status ?? null
    };
  });
}
