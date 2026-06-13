// Phase AUTO-RUNNER16X — market refresh target universe (pure data + helpers).
//
// Defines the verified live target set (Booking/Jalan) plus candidate_only
// properties that are NOT live-collected until their collector mapping is
// verified in a dedicated phase. No invented slugs/ids: candidates carry an
// empty source key and verified_mapping=false. Rakuten/Google remain disabled.

export type TargetSource = "booking" | "jalan" | "rakuten" | "google_hotels";
export type TargetTier =
  | "tier_anchor_high"
  | "tier_direct_mid"
  | "tier_budget_small"
  | "tier_monitor_only";

export interface MarketRefreshPropertyTarget {
  source: TargetSource;
  canonical_property_name: string;
  property_slug: string;
  source_property_id?: string;
  source_url?: string;
  tier: TargetTier;
  enabled_for_live: boolean;
  verified_mapping: boolean;
  verification_note: string;
}

// Verified live targets — proven collector mappings already used by
// autoRunnerBookingPreview (Booking slugs) and autoRunnerMarketRefresh (Jalan yads).
export const VERIFIED_LIVE_TARGETS: readonly MarketRefreshPropertyTarget[] = [
  // Booking — anchor-high price references
  { source: "booking", canonical_property_name: "蔵王国際ホテル", property_slug: "zao-kokusai", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified_booking_rendered_dom_probe" },
  { source: "booking", canonical_property_name: "蔵王四季のホテル", property_slug: "zao-shiki-no", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified_booking_rendered_dom_probe" },
  { source: "booking", canonical_property_name: "深山荘 高見屋", property_slug: "shinzanso-takamiya", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified_booking_rendered_dom_probe" },
  // Jalan — direct-competitor mid tier
  { source: "jalan", canonical_property_name: "ホテル喜らく", property_slug: "yad325153", source_property_id: "yad325153", source_url: "https://www.jalan.net/yad325153/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  { source: "jalan", canonical_property_name: "ル・ベール蔵王", property_slug: "yad328232", source_property_id: "yad328232", source_url: "https://www.jalan.net/yad328232/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  { source: "jalan", canonical_property_name: "HAMMOND", property_slug: "yad348320", source_property_id: "yad348320", source_url: "https://www.jalan.net/yad348320/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  { source: "jalan", canonical_property_name: "吉田屋", property_slug: "yad327282", source_property_id: "yad327282", source_url: "https://www.jalan.net/yad327282/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  { source: "jalan", canonical_property_name: "JURIN", property_slug: "yad332556", source_property_id: "yad332556", source_url: "https://www.jalan.net/yad332556/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  // Promoted in AUTO-RUNNER16X-A3: identity verified via verify:source-mappings
  // (2026-06-10 probe) — name+region matched, clean load, no captcha/login.
  // NOTE: Phase 41X observed Booking bot-detection inconsistency for this slug;
  // the Booking collector classifies per-run (directional only on safe price,
  // else excluded), so unstable runs degrade to excluded rows, never bad data.
  // Monitor extraction stability during the 16X-B pilot.
  { source: "booking", canonical_property_name: "ル・ベール蔵王", property_slug: "le-vert-zao", source_url: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A3 verify:source-mappings 2026-06-10 (A, name+region match, clean load); extraction stability monitored in pilot" },
  // Promoted in AUTO-RUNNER16X-A4: identity verified via discover:source-mappings
  // (2026-06-10 runs 20260610_202237 / 20260610_204127) — public OTA page discovery
  // (Jalan 蔵王温泉 keyword listing / Booking searchresults area scan + Phase 47X
  // public seeds), then live identity probe: name/alias + region match, clean load,
  // no captcha/login. All confidence A. Discovery never collected prices.
  // Jalan — discovered on the public 蔵王温泉 keyword listing (distCd=06, rootCd=7701).
  { source: "jalan", canonical_property_name: "おおみや旅館", property_slug: "yad338565", source_property_id: "yad338565", source_url: "https://www.jalan.net/yad338565/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "ONSEN & STAY OAKHILL", property_slug: "yad388065", source_property_id: "yad388065", source_url: "https://www.jalan.net/yad388065/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "源泉湯宿 蔵王プラザホテル", property_slug: "yad353340", source_property_id: "yad353340", source_url: "https://www.jalan.net/yad353340/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "ＫＫＲ蔵王 白銀荘", property_slug: "yad393448", source_property_id: "yad393448", source_url: "https://www.jalan.net/yad393448/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "たかみや瑠璃倶楽", property_slug: "yad316848", source_property_id: "yad316848", source_url: "https://www.jalan.net/yad316848/", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "こけしの宿 招仙閣", property_slug: "yad348951", source_property_id: "yad348951", source_url: "https://www.jalan.net/yad348951/", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "名湯リゾート ルーセントタカミヤ", property_slug: "yad331969", source_property_id: "yad331969", source_url: "https://www.jalan.net/yad331969/", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "名湯舎 創", property_slug: "yad396378", source_property_id: "yad396378", source_url: "https://www.jalan.net/yad396378/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "蔵王・和歌（うた）の宿 わかまつや", property_slug: "yad334773", source_property_id: "yad334773", source_url: "https://www.jalan.net/yad334773/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "深山荘 高見屋", property_slug: "yad321744", source_property_id: "yad321744", source_url: "https://www.jalan.net/yad321744/", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "蔵王国際ホテル", property_slug: "yad309590", source_property_id: "yad309590", source_url: "https://www.jalan.net/yad309590/", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "蔵王四季のホテル", property_slug: "yad322447", source_property_id: "yad322447", source_url: "https://www.jalan.net/yad322447/", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  // Booking — discovered via first-party searchresults area scan (ss=蔵王温泉),
  // per-candidate fallback searches, and Phase 47X public seeds.
  { source: "booking", canonical_property_name: "おおみや旅館", property_slug: "omiya-ryokan-yamagata", source_url: "https://www.booking.com/hotel/jp/omiya-ryokan-yamagata.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  { source: "booking", canonical_property_name: "ONSEN & STAY OAKHILL", property_slug: "onsen-amp-stay-oakhill", source_url: "https://www.booking.com/hotel/jp/onsen-amp-stay-oakhill.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  { source: "booking", canonical_property_name: "源泉湯宿 蔵王プラザホテル", property_slug: "zao-plaza", source_url: "https://www.booking.com/hotel/jp/zao-plaza.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  { source: "booking", canonical_property_name: "ロッジスガノ", property_slug: "rotudi-sugano", source_url: "https://www.booking.com/hotel/jp/rotudi-sugano.ja.html", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults (display name ロッヂ スガノ)" },
  { source: "booking", canonical_property_name: "松尾ハウス", property_slug: "winter-season-matsuo-house-room-natsu", source_url: "https://www.booking.com/hotel/jp/winter-season-matsuo-house-room-natsu.ja.html", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults; NOTE: seasonal 民泊 private-room listing (Green/Winter Season - Matsuo House) — monitor extraction semantics in pilot" },
  { source: "booking", canonical_property_name: "ＫＫＲ蔵王 白銀荘", property_slug: "kkrzaohakuginso", source_url: "https://www.booking.com/hotel/jp/kkrzaohakuginso.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking fallback searchresults (ss=KKR蔵王白銀荘)" },
  { source: "booking", canonical_property_name: "たかみや瑠璃倶楽", property_slug: "rurikura-resort", source_url: "https://www.booking.com/hotel/jp/rurikura-resort.ja.html", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  { source: "booking", canonical_property_name: "名湯リゾート ルーセントタカミヤ", property_slug: "lucent-takamiya", source_url: "https://www.booking.com/hotel/jp/lucent-takamiya.ja.html", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  { source: "booking", canonical_property_name: "名湯舎 創", property_slug: "meitoya-sou", source_url: "https://www.booking.com/hotel/jp/meitoya-sou.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  { source: "booking", canonical_property_name: "蔵王・和歌（うた）の宿 わかまつや", property_slug: "wakamatsuya", source_url: "https://www.booking.com/hotel/jp/wakamatsuya.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  { source: "booking", canonical_property_name: "HAMMOND", property_slug: "hammond-takamiya", source_url: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  { source: "booking", canonical_property_name: "吉田屋", property_slug: "ji-tian-wu-shan-xing-shi", source_url: "https://www.booking.com/hotel/jp/ji-tian-wu-shan-xing-shi.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults (title Yoshidaya（蔵王温泉）, breadcrumb 山形県/蔵王温泉)" },
  { source: "booking", canonical_property_name: "JURIN", property_slug: "jurin", source_url: "https://www.booking.com/hotel/jp/jurin.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-A4 discover:source-mappings 2026-06-10 (A, name+region match, clean load); booking area searchresults + phase47X public seed" },
  // Promoted in AUTO-RUNNER16X-F: identity verified via discover:source-mappings
  // over the expanded Zao Onsen property master (2026-06-14 run 20260614_013135).
  // Public OTA page discovery (Jalan 蔵王温泉 keyword listing / Booking searchresults
  // area scan + per-name fallback) then live identity probe: name/alias + region
  // match, clean load, no captcha/login. All confidence A. No prices collected.
  // Jalan additions:
  { source: "jalan", canonical_property_name: "三浦屋", property_slug: "yad302145", source_property_id: "yad302145", source_url: "https://www.jalan.net/yad302145/", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing; own property self-monitor" },
  { source: "jalan", canonical_property_name: "ホテル松金屋アネックス", property_slug: "yad335940", source_property_id: "yad335940", source_url: "https://www.jalan.net/yad335940/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "蔵王アストリアホテル", property_slug: "yad385780", source_property_id: "yad385780", source_url: "https://www.jalan.net/yad385780/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "蔵王温泉 高砂屋旅館", property_slug: "yad391608", source_property_id: "yad391608", source_url: "https://www.jalan.net/yad391608/", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "ペンションぷうたろう", property_slug: "yad394784", source_property_id: "yad394784", source_url: "https://www.jalan.net/yad394784/", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  { source: "jalan", canonical_property_name: "ペンション櫻", property_slug: "yad343698", source_property_id: "yad343698", source_url: "https://www.jalan.net/yad343698/", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing (booking side needs_review: region unconfirmed)" },
  { source: "jalan", canonical_property_name: "ペンション木いちご", property_slug: "yad325769", source_property_id: "yad325769", source_url: "https://www.jalan.net/yad325769/", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); jalan 蔵王温泉 keyword listing" },
  // Booking additions:
  { source: "booking", canonical_property_name: "三浦屋", property_slug: "japanese-hostel-miuraya", source_url: "https://www.booking.com/hotel/jp/japanese-hostel-miuraya.ja.html", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); booking area searchresults; own property self-monitor" },
  { source: "booking", canonical_property_name: "ホテル松金屋アネックス", property_slug: "matukaneya-annex", source_url: "https://www.booking.com/hotel/jp/matukaneya-annex.ja.html", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); booking area searchresults" },
  { source: "booking", canonical_property_name: "蔵王温泉 高砂屋旅館", property_slug: "takasagoya-ryokan", source_url: "https://www.booking.com/hotel/jp/takasagoya-ryokan.ja.html", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); booking area searchresults" },
  { source: "booking", canonical_property_name: "ロッジまつぽっくり", property_slug: "matsupokkuri", source_url: "https://www.booking.com/hotel/jp/matsupokkuri.ja.html", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); booking area searchresults" },
  { source: "booking", canonical_property_name: "ペンションぷうたろう", property_slug: "pension-puutaro-yamagata", source_url: "https://www.booking.com/hotel/jp/pension-puutaro-yamagata.ja.html", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); booking area searchresults" },
  { source: "booking", canonical_property_name: "ペンション木いちご", property_slug: "pensiyonmu-itigo", source_url: "https://www.booking.com/hotel/jp/pensiyonmu-itigo.ja.html", tier: "tier_budget_small", enabled_for_live: true, verified_mapping: true, verification_note: "verified identity via 16X-F discover:source-mappings 2026-06-14 (A, name+region match, clean load); booking area searchresults" }
] as const;

// Candidate-only properties — NOT live-collected. No slug/id is invented.
// AUTO-RUNNER16X-A4 (2026-06-10) ran public OTA discovery over all prior
// candidates: most were identity-verified and promoted to VERIFIED_LIVE_TARGETS
// above. The rows below were NOT found on the target OTA after public search
// (Jalan 蔵王温泉 keyword listing + per-name keyword searches; Booking area
// searchresults + per-name fallback searches) — evidence in
// .data/reports/source-mapping-discovery/source_mapping_discovery_20260610_202237.*.
// They stay candidate_only until a property URL is provided manually.
export const CANDIDATE_ONLY_TARGETS: readonly MarketRefreshPropertyTarget[] = [
  { source: "jalan", canonical_property_name: "ぼくのうち", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-A4 not_found_after_public_search (jalan 蔵王温泉 listing + keyword searches 2026-06-10); provide URL manually if listed" },
  { source: "jalan", canonical_property_name: "ロッジスガノ", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-A4 not_found_after_public_search on jalan (booking side IS live-verified: rotudi-sugano); provide jalan URL manually if listed" },
  { source: "jalan", canonical_property_name: "松尾ハウス", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-A4 not_found_after_public_search on jalan (booking side IS live-verified); provide jalan URL manually if listed" },
  { source: "booking", canonical_property_name: "ぼくのうち", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-A4 not_found_after_public_search (booking area scan + fallback searches 2026-06-10); provide URL manually if listed" },
  { source: "booking", canonical_property_name: "こけしの宿 招仙閣", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-A4 not_found_after_public_search on booking (jalan side IS live-verified: yad348951); provide booking URL manually if listed" },
  { source: "booking", canonical_property_name: "ホテル喜らく", property_slug: "", tier: "tier_direct_mid", enabled_for_live: false, verified_mapping: false, verification_note: "16X-A4 not_found_after_public_search on booking (jalan side IS live-verified: yad325153); provide booking URL manually if listed" },
  // AUTO-RUNNER16X-F expanded-master candidates that could not be verified on the
  // target OTA (run 20260614_013135). enabled_for_live=false / verified_mapping=false;
  // provide a property URL manually to promote. No slug/id invented.
  { source: "jalan", canonical_property_name: "ロッジまつぽっくり", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search on jalan (booking side IS live-verified: matsupokkuri); provide jalan URL manually if listed" },
  { source: "jalan", canonical_property_name: "ロッジイザワ", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (jalan); provide URL manually if listed" },
  { source: "booking", canonical_property_name: "ロッジイザワ", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (booking); provide URL manually if listed" },
  { source: "jalan", canonical_property_name: "ペンションキャンドル", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (jalan); provide URL manually if listed" },
  { source: "booking", canonical_property_name: "ペンションキャンドル", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (booking); provide URL manually if listed" },
  { source: "jalan", canonical_property_name: "ペンションエプロンステージ", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (jalan); provide URL manually if listed" },
  { source: "booking", canonical_property_name: "ペンションエプロンステージ", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (booking); provide URL manually if listed" },
  { source: "jalan", canonical_property_name: "フォーレスト蔵王温泉", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (jalan); provide URL manually if listed" },
  { source: "booking", canonical_property_name: "フォーレスト蔵王温泉", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (booking); provide URL manually if listed" },
  { source: "jalan", canonical_property_name: "蔵王センタープラザ", property_slug: "", tier: "tier_direct_mid", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (jalan); provide URL manually if listed" },
  { source: "booking", canonical_property_name: "蔵王センタープラザ", property_slug: "", tier: "tier_direct_mid", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (booking); provide URL manually if listed" },
  { source: "jalan", canonical_property_name: "ホテルラルジャン蔵王", property_slug: "", tier: "tier_direct_mid", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (jalan); provide URL manually if listed" },
  { source: "booking", canonical_property_name: "ホテルラルジャン蔵王", property_slug: "", tier: "tier_direct_mid", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search (booking); provide URL manually if listed" },
  { source: "booking", canonical_property_name: "蔵王アストリアホテル", property_slug: "", tier: "tier_direct_mid", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F not_found_after_public_search on booking (jalan side IS live-verified: yad385780); provide booking URL manually if listed" },
  { source: "booking", canonical_property_name: "ペンション櫻", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "16X-F candidate_found_needs_review on booking (region not confirmed on property page; jalan side IS live-verified: yad343698); manual confirm before promotion" }
] as const;

export function liveTargets(source?: TargetSource): MarketRefreshPropertyTarget[] {
  return VERIFIED_LIVE_TARGETS.filter((t) => t.enabled_for_live && t.verified_mapping && (source === undefined || t.source === source));
}

export function liveBookingTargets(): MarketRefreshPropertyTarget[] {
  return liveTargets("booking");
}

export function liveJalanTargets(): MarketRefreshPropertyTarget[] {
  return liveTargets("jalan");
}

export function candidateTargets(): MarketRefreshPropertyTarget[] {
  return [...CANDIDATE_ONLY_TARGETS];
}

export function tierOf(source: TargetSource, propertySlug: string): TargetTier | null {
  return VERIFIED_LIVE_TARGETS.find((t) => t.source === source && t.property_slug === propertySlug)?.tier ?? null;
}

export function isLiveVerified(source: TargetSource, propertySlug: string): boolean {
  return VERIFIED_LIVE_TARGETS.some((t) => t.source === source && t.property_slug === propertySlug && t.enabled_for_live && t.verified_mapping);
}

export interface UniverseSummary {
  booking_live_verified: number;
  jalan_live_verified: number;
  rakuten_live: number;
  google_hotels_live: number;
  candidate_only: number;
  by_tier: Record<string, number>;
}

export function summarizeUniverse(): UniverseSummary {
  const byTier: Record<string, number> = {};
  for (const t of VERIFIED_LIVE_TARGETS) byTier[t.tier] = (byTier[t.tier] ?? 0) + 1;
  return {
    booking_live_verified: liveBookingTargets().length,
    jalan_live_verified: liveJalanTargets().length,
    rakuten_live: 0,
    google_hotels_live: 0,
    candidate_only: CANDIDATE_ONLY_TARGETS.length,
    by_tier: byTier
  };
}
