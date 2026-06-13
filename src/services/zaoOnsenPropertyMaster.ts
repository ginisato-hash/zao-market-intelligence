// Phase AUTO-RUNNER16X-F — Zao Onsen expanded property master (pure data).
//
// The canonical universe of lodging properties we monitor in 蔵王温泉 / 山形市.
// This is a NAME/ALIAS/category catalog only — it carries NO source slugs or
// yadIds. Mapping a master entry to a live OTA target is the job of the source
// mapping discovery phase (identity-only, public OTA pages); only discovery-
// verified (name+alias+region+concrete URL/id) entries are promoted to the
// live universe. Rakuten/Google appear in expected_sources for coverage
// roadmap only — they are never live-collected (planner caps = 0).

export type ZaoOnsenPropertyCategory =
  | "hotel"
  | "ryokan"
  | "pension"
  | "lodge"
  | "guesthouse"
  | "private_rental"
  | "unknown";

export type ZaoOnsenExpectedSource = "booking" | "jalan" | "rakuten" | "google_hotels";

export interface ZaoOnsenPropertyMasterEntry {
  canonical_property_name: string;
  aliases: readonly string[];
  category: ZaoOnsenPropertyCategory;
  tier:
    | "tier_anchor_high"
    | "tier_direct_mid"
    | "tier_budget_small"
    | "tier_monitor_only";
  priority: "high" | "medium" | "low";
  expected_sources: readonly ZaoOnsenExpectedSource[];
  notes: string;
}

export const ZAO_ONSEN_EXPANDED_PROPERTY_MASTER: readonly ZaoOnsenPropertyMasterEntry[] = [
  {
    canonical_property_name: "蔵王国際ホテル",
    aliases: ["Zao Kokusai Hotel", "蔵王国際"],
    category: "hotel",
    tier: "tier_anchor_high",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "既存verified。anchor high."
  },
  {
    canonical_property_name: "蔵王四季のホテル",
    aliases: ["Zao Shiki no Hotel", "蔵王四季"],
    category: "hotel",
    tier: "tier_anchor_high",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "既存verified。anchor high."
  },
  {
    canonical_property_name: "深山荘 高見屋",
    aliases: ["Miyamaso Takamiya", "深山荘高見屋"],
    category: "ryokan",
    tier: "tier_anchor_high",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "既存verified。anchor high."
  },
  {
    canonical_property_name: "名湯リゾート ルーセントタカミヤ",
    aliases: ["ルーセントタカミヤ", "Lucent Takamiya"],
    category: "hotel",
    tier: "tier_anchor_high",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "高見屋系。既存verified候補。"
  },
  {
    canonical_property_name: "たかみや瑠璃倶楽",
    aliases: ["瑠璃倶楽", "Rurikura Resort", "高見屋瑠璃倶楽"],
    category: "hotel",
    tier: "tier_anchor_high",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "高見屋系。"
  },
  {
    canonical_property_name: "名湯舎 創",
    aliases: ["名湯舎創", "Meitoya So"],
    category: "ryokan",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "direct competitor."
  },
  {
    canonical_property_name: "JURIN",
    aliases: ["ジュリン", "ホテル樹林", "Forest Inn Sangoro", "Takamiya Hotel Jurin"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "既存verified。"
  },
  {
    canonical_property_name: "HAMMOND",
    aliases: ["ホテルハモンドたかみや", "Hammond Takamiya", "HAMMOND TAKAMIYA"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "既存verified。Booking extractorの¥100異常はfloorで除外。"
  },
  {
    canonical_property_name: "おおみや旅館",
    aliases: ["Omiya Ryokan", "蔵王温泉 おおみや旅館"],
    category: "ryokan",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "direct competitor."
  },
  {
    canonical_property_name: "吉田屋",
    aliases: ["Yoshidaya", "蔵王温泉 吉田屋"],
    category: "ryokan",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "既存verified。"
  },
  {
    canonical_property_name: "ル・ベール蔵王",
    aliases: ["Le Vert Zao", "ルベール蔵王"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "既存verified。"
  },
  {
    canonical_property_name: "ホテル喜らく",
    aliases: ["喜らく", "Hotel Kiraku", "旅館きらく"],
    category: "ryokan",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["jalan", "rakuten", "google_hotels"],
    notes: "自社/運営対象。Booking未確認ならcandidate_only。"
  },
  {
    canonical_property_name: "ONSEN & STAY OAKHILL",
    aliases: ["OAKHILL", "オークヒル", "ホテルオークヒル", "蔵王温泉ホテルオークヒル"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "direct competitor."
  },
  {
    canonical_property_name: "源泉湯宿 蔵王プラザホテル",
    aliases: ["蔵王プラザホテル", "Zao Plaza Hotel"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "direct competitor."
  },
  {
    canonical_property_name: "こけしの宿 招仙閣",
    aliases: ["招仙閣", "Kokeshi no Yado Shosenkaku"],
    category: "ryokan",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["jalan", "rakuten", "google_hotels"],
    notes: "budget/small."
  },
  {
    canonical_property_name: "ＫＫＲ蔵王 白銀荘",
    aliases: ["KKR蔵王白銀荘", "KKR Zao Hakuginso", "白銀荘"],
    category: "ryokan",
    tier: "tier_direct_mid",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "direct/mid."
  },
  {
    canonical_property_name: "蔵王・和歌の宿 わかまつや",
    aliases: ["わかまつや", "Wakamatsuya"],
    category: "ryokan",
    tier: "tier_direct_mid",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "direct/mid."
  },
  {
    canonical_property_name: "ロッジスガノ",
    aliases: ["ロッヂ スガノ", "Lodge Sugano", "Sugano"],
    category: "lodge",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "budget/small."
  },
  {
    canonical_property_name: "松尾ハウス",
    aliases: ["Matsuo House", "Green/Winter Season Matsuo House"],
    category: "private_rental",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "rakuten", "google_hotels"],
    notes: "seasonal/private-room listing。抽出semantics注意。"
  },
  {
    canonical_property_name: "ぼくのうち",
    aliases: ["Boku no Uchi", "ぼくの家", "ぼくのうち 蔵王"],
    category: "guesthouse",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "未verifiedならcandidate_only。"
  },
  {
    canonical_property_name: "ロッジまつぽっくり",
    aliases: ["まつぽっくり", "Lodge Matsupokkuri", "Matsupokkuri"],
    category: "lodge",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "ロッジイザワ",
    aliases: ["Lodge Izawa", "Izawa Lodge", "ロッヂイザワ"],
    category: "lodge",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "ペンションぷうたろう",
    aliases: ["ぷうたろう", "Pension Puutaro", "Pension Putaro"],
    category: "pension",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "ペンションキャンドル",
    aliases: ["Pension Candle", "キャンドル"],
    category: "pension",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "ペンション櫻",
    aliases: ["ペンション桜", "Pension Sakura", "櫻"],
    category: "pension",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "ペンション木いちご",
    aliases: ["木いちご", "Pension Kiichigo"],
    category: "pension",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "ペンションエプロンステージ",
    aliases: ["エプロンステージ", "Pension Apron Stage", "Apron Stage"],
    category: "pension",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "フォーレスト蔵王温泉",
    aliases: ["Forest Zao Onsen", "フォーレスト蔵王"],
    category: "hotel",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "蔵王センタープラザ",
    aliases: ["Zao Center Plaza", "センタープラザ"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "ホテルラルジャン蔵王",
    aliases: ["ラルジャン蔵王", "Hotel Largent Zao", "Largent Zao"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "ホテル松金屋アネックス",
    aliases: ["松金屋アネックス", "Matsukaneya Annex"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "蔵王アストリアホテル",
    aliases: ["アストリアホテル", "Zao Astraea Hotel", "Astraea Hotel"],
    category: "hotel",
    tier: "tier_direct_mid",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "蔵王温泉 高砂屋旅館",
    aliases: ["高砂屋旅館", "Takasagoya Ryokan"],
    category: "ryokan",
    tier: "tier_budget_small",
    priority: "medium",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "追加候補。"
  },
  {
    canonical_property_name: "三浦屋",
    aliases: ["Miuraya", "三浦屋旅館", "蔵王温泉 三浦屋"],
    category: "guesthouse",
    tier: "tier_budget_small",
    priority: "high",
    expected_sources: ["booking", "jalan", "rakuten", "google_hotels"],
    notes: "自社。競合ではなく自社モニタ用。source mappingがある場合のみlive。"
  }
] as const;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ヂぢ]/gu, "ジ")
    .replace(/[ヅづ]/gu, "ズ")
    .replace(/[\s　・･,，.。'’‘"“”\-–—‐~〜（）()【】[\]/／&＆]+/gu, "");
}

/** Look up a master entry by canonical name or any alias (normalized). */
export function findMasterEntry(name: string): ZaoOnsenPropertyMasterEntry | undefined {
  const needle = normalize(name);
  if (needle === "") return undefined;
  return ZAO_ONSEN_EXPANDED_PROPERTY_MASTER.find(
    (e) => normalize(e.canonical_property_name) === needle || e.aliases.some((a) => normalize(a) === needle)
  );
}

export interface PropertyMasterSummary {
  total: number;
  by_category: Record<string, number>;
  by_tier: Record<string, number>;
  by_priority: Record<string, number>;
  duplicate_canonical_names: string[];
}

export function summarizePropertyMaster(): PropertyMasterSummary {
  const byCategory: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const seen = new Map<string, number>();
  for (const e of ZAO_ONSEN_EXPANDED_PROPERTY_MASTER) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    byTier[e.tier] = (byTier[e.tier] ?? 0) + 1;
    byPriority[e.priority] = (byPriority[e.priority] ?? 0) + 1;
    const key = normalize(e.canonical_property_name);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return {
    total: ZAO_ONSEN_EXPANDED_PROPERTY_MASTER.length,
    by_category: byCategory,
    by_tier: byTier,
    by_priority: byPriority,
    duplicate_canonical_names: [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  };
}
