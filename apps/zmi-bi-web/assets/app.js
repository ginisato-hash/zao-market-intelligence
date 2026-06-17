/* ZMI BI Web — production UI. All-source unified, no fake controls, no CSV upload. */
const ROOM_ONLY_COMPS = ["HAMMOND", "ONSEN & STAY OAKHILL", "吉田屋"];
const COMP_LABEL = { "HAMMOND": "HAMMOND", "ONSEN & STAY OAKHILL": "OAKHILL", "吉田屋": "吉田屋" };
const GROUP_TIER = { anchor: "tier_anchor_high", mid: "tier_direct_mid", budget: "tier_budget_small" };

const state = {
  rows: [], meta: null, activeTab: "overview", period: "", group: "all", confidence: "all", search: "", loading: false, error: ""
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isTrue = (v) => String(v).toLowerCase() === "true";
const yen = (n) => (n == null || Number.isNaN(n) ? "—" : `${Number(n).toLocaleString("ja-JP")} 円`);
const pct = (n) => (n == null || Number.isNaN(n) ? "—" : `${(n * 100).toFixed(1)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shortTs = (s) => (s || "").slice(5, 16).replace("T", " ");

function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const split = (line) => {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = !q;
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const header = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line); const obj = {};
    header.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
    return obj;
  });
}

function comparePeriod(a, b) {
  const norm = (k) => `${String(k).slice(0, 7)}${String(k).endsWith("_early") ? "0" : "1"}`;
  return norm(a) < norm(b) ? -1 : norm(a) > norm(b) ? 1 : 0;
}
function sortPeriodKeys(keys) { return [...new Set(keys.filter(Boolean))].sort(comparePeriod); }
function getCurrentPeriodKeyJst(date = new Date()) {
  const jst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const day = Number(jst.slice(8, 10));
  return `${jst.slice(0, 7)}_${day <= 15 ? "early" : "late"}`;
}
function pickDefaultPeriodKey(keys) {
  if (!keys.length) return "";
  const urlPeriod = new URLSearchParams(location.search).get("period");
  if (urlPeriod && keys.includes(urlPeriod)) return urlPeriod;
  const metaDefault = state.meta?.default_period_key;
  if (metaDefault && keys.includes(metaDefault)) return metaDefault;
  const current = state.meta?.current_period_key_jst || getCurrentPeriodKeyJst();
  if (keys.includes(current)) return current;
  return keys.find((k) => comparePeriod(k, current) > 0) || keys[keys.length - 1];
}
function periodKeys() { return sortPeriodKeys(state.rows.map((r) => r.period_key)); }
function periodLabel(key) {
  const row = state.rows.find((r) => r.period_key === key && r.period_label);
  if (row) return row.period_label;
  const [ym, half] = String(key).split("_");
  return `${(ym || "").slice(0, 4)}年${Number((ym || "").slice(5, 7))}月 ${half === "early" ? "上旬" : "下旬"}`;
}
function prevPeriod(key) { const keys = periodKeys(); const i = keys.indexOf(key); return i > 0 ? keys[i - 1] : null; }

function rankConf(c) { return c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0; }
function applyGroup(rows) {
  if (state.group === "own") return rows.filter((r) => isTrue(r.is_own_property));
  if (state.group === "room_comp") return rows.filter((r) => isTrue(r.is_room_only_comp));
  if (GROUP_TIER[state.group]) return rows.filter((r) => r.tier === GROUP_TIER[state.group]);
  return rows;
}
function applyConfidence(rows) {
  if (state.confidence === "all") return rows;
  if (state.confidence === "high") return rows.filter((r) => r.price_confidence === "high" || r.inventory_confidence === "high");
  if (state.confidence === "medium_or_high") return rows.filter((r) => rankConf(r.price_confidence) >= 2 || rankConf(r.inventory_confidence) >= 2);
  if (state.confidence === "low") return rows.filter((r) => r.price_confidence === "low" && r.inventory_confidence === "low");
  return rows;
}
function applySearch(rows) {
  const q = state.search.trim().toLowerCase();
  return q ? rows.filter((r) => String(r.canonical_property_name).toLowerCase().includes(q)) : rows;
}
function baseRows(key = state.period) { return state.rows.filter((r) => r.period_key === key); }
function filteredRows(key = state.period) { return applySearch(applyConfidence(applyGroup(baseRows(key)))); }
function aggregateByProperty(rows) {
  const m = new Map();
  rows.forEach((r) => {
    const name = r.canonical_property_name || "不明";
    const e = m.get(name) || { name, tier: r.tier || "", prices: [], statuses: [], latest: "", srcMax: 0, priceConf: "low", basisConf: "low", coverageConf: "low", invConf: "low", roomOnlySamples: 0, excludedMealSamples: 0, unknownMealCount: 0, twoPersonSamples: 0, excludedRoomTypeSamples: 0, unknownRoomCount: 0, own: isTrue(r.is_own_property), comp: isTrue(r.is_room_only_comp), days: 0, soldDays: 0, availableDays: 0, nodataDays: 0 };
    const price = num(r.median_directional_price);
    if (price != null && price > 0) e.prices.push(price);
    const st = r.unified_availability_status || "no_data";
    e.statuses.push(st);
    if (st === "sold_out") e.soldDays++;
    else if (st === "available") e.availableDays++;
    else e.nodataDays++;
    if (st === "sold_out" || st === "available") e.days++;
    e.srcMax = Math.max(e.srcMax, num(r.source_count) || 0);
    e.roomOnlySamples += num(r.room_only_price_sample_count) || 0;
    e.excludedMealSamples += num(r.excluded_meal_price_sample_count) || 0;
    e.unknownMealCount += num(r.unknown_meal_basis_count) || 0;
    e.twoPersonSamples += num(r.two_person_room_price_sample_count) || 0;
    e.excludedRoomTypeSamples += num(r.excluded_room_type_price_sample_count) || 0;
    e.unknownRoomCount += num(r.unknown_room_basis_count) || 0;
    if ((r.latest_collected_at_jst || "") > e.latest) e.latest = r.latest_collected_at_jst || "";
    if (rankConf(r.price_confidence) > rankConf(e.priceConf)) e.priceConf = r.price_confidence || "low";
    if (rankConf(r.price_basis_confidence) > rankConf(e.basisConf)) e.basisConf = r.price_basis_confidence || "low";
    if (rankConf(r.price_coverage_confidence) > rankConf(e.coverageConf)) e.coverageConf = r.price_coverage_confidence || "low";
    if (rankConf(r.inventory_confidence) > rankConf(e.invConf)) e.invConf = r.inventory_confidence || "low";
    m.set(name, e);
  });
  return [...m.values()].map((e) => {
    const sorted = [...e.prices].sort((a, b) => a - b);
    return {
      ...e,
      medianPrice: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
      avgPrice: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
      status: e.statuses.includes("available") ? "available" : e.statuses.includes("sold_out") ? "sold_out" : e.statuses.includes("not_found") ? "not_found" : "no_data"
    };
  });
}
function aggregateDaily(rows) {
  const m = new Map();
  rows.forEach((r) => {
    const key = r.checkin || "";
    const e = m.get(key) || { checkin: key, prices: [], avail: 0, sold: 0, nodata: 0 };
    const price = num(r.median_directional_price);
    if (price != null && price > 0) e.prices.push(price);
    if (r.unified_availability_status === "available") e.avail++;
    else if (r.unified_availability_status === "sold_out") e.sold++;
    else e.nodata++;
    m.set(key, e);
  });
  return [...m.values()].sort((a, b) => a.checkin.localeCompare(b.checkin)).map((e) => ({
    ...e,
    avg: e.prices.length ? Math.round(e.prices.reduce((a, b) => a + b, 0) / e.prices.length) : null,
    rate: (e.avail + e.sold) === 0 ? null : e.sold / (e.avail + e.sold)
  }));
}
function avgPrice(rows) { const ps = rows.map((r) => num(r.median_directional_price)).filter((p) => p != null && p > 0); return ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null; }
function soldRate(rows) { let a = 0; let s = 0; rows.forEach((r) => { if (r.unified_availability_status === "available") a++; else if (r.unified_availability_status === "sold_out") s++; }); return (a + s) === 0 ? null : s / (a + s); }

function statusPill(s) { const label = s === "available" ? "OTA販売可" : s === "sold_out" ? "OTA販売不可" : s === "not_found" ? "not_found" : "観測なし"; return `<span class="status-pill status-${esc(s)}">${label}</span>`; }
function confPill(c) { const v = c || "low"; return `<span class="confidence-pill confidence-${esc(v)}">${esc(v)}</span>`; }
function spark(vals) {
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return `<span class="flat">—</span>`;
  const w = 96, h = 26, min = Math.min(...v), max = Math.max(...v);
  const pts = v.map((y, i) => `${(i * w) / (v.length - 1)},${h - ((y - min) / Math.max(1, max - min)) * (h - 6) - 3}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function lineChart(points) {
  const pts = points.filter((d) => d.y != null); const w = 600, h = 200, pad = 30;
  if (!pts.length) return `<div class="empty">価格データなし</div>`;
  const ys = pts.map((d) => d.y), min = Math.min(...ys), max = Math.max(...ys);
  const X = (i) => pad + (i * (w - pad * 2)) / Math.max(1, pts.length - 1);
  const Y = (v) => h - pad - ((v - min) / Math.max(1, max - min)) * (h - pad * 2);
  const poly = pts.map((d, i) => `${X(i).toFixed(1)},${Y(d.y).toFixed(1)}`).join(" ");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${poly}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
}
function stackChart(daily) {
  const w = 600, h = 200, pad = 22;
  if (!daily.length) return `<div class="empty">データなし</div>`;
  const bw = (w - pad * 2) / daily.length; let bars = "";
  daily.forEach((d, i) => {
    const tot = d.avail + d.sold + d.nodata || 1; let y = h - pad; const x = pad + i * bw;
    [["#16a34a", d.avail], ["#ef4444", d.sold], ["#cbd5e1", d.nodata]].forEach(([c, v]) => {
      const sh = (v / tot) * (h - pad * 2); y -= sh;
      bars += `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${sh.toFixed(1)}" fill="${c}"/>`;
    });
  });
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
}
function heatColor(v) { if (v == null) return "#f1f3f5"; const hue = 120 - Math.min(1, v) * 120; return `hsl(${hue} 75% 88%)`; }

// --- axis / caption helpers (every chart & table shows axes, unit, period, source) ---
function srcLabel() { return (state.meta?.sources_included?.length ? state.meta.sources_included.join(" / ") : "booking / jalan / rakuten") + " 統合"; }
function periodText() { return state.period ? periodLabel(state.period) : "—"; }
function axisBlock(xLabel, yLabel) {
  return `<div class="axis"><span class="axis-item"><b>横軸</b>: ${esc(xLabel)}</span><span class="axis-item"><b>縦軸</b>: ${esc(yLabel)}</span></div>`;
}
function chartCaption(metric, xLabel, yLabel, unit, granularity) {
  return `<p class="chart-cap">指標: ${esc(metric)} ／ 横軸: ${esc(xLabel)} ／ 縦軸: ${esc(yLabel)}（単位: ${esc(unit)}） ／ 集計粒度: ${esc(granularity)} ／ 対象期間: ${esc(periodText())} ／ source: ${esc(srcLabel())}</p>`;
}
// Full chart panel: title, description, legend, axis labels, svg, caption.
function chartPanel(opts) {
  return `<div class="panel">
    <h2>${esc(opts.title)}</h2>
    <p class="chart-desc">${esc(opts.description)}</p>
    ${opts.legend || ""}
    ${axisBlock(opts.xLabel, opts.yLabel)}
    ${opts.svg}
    ${chartCaption(opts.metric, opts.xLabel, opts.yLabel, opts.unit, opts.granularity)}
  </div>`;
}
function tableCaption(title, description, count) {
  return `<caption class="tbl-cap"><span class="tbl-title">${esc(title)}</span><span class="tbl-desc">${esc(description)} ／ 件数: ${count}件 ／ 対象期間: ${esc(periodText())} ／ source: ${esc(srcLabel())}</span></caption>`;
}

function render() {
  renderHeader();
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.activeTab));
  const banner = $("#errorBanner");
  if (state.error) { banner.hidden = false; banner.textContent = state.error; } else banner.hidden = true;
  const main = $("#main");
  if (state.loading) { main.innerHTML = `<section class="panel"><div class="empty">読込中…</div></section>`; return; }
  if (!state.rows.length) { main.innerHTML = `<section class="panel"><div class="empty">公開データがありません</div></section>`; return; }
  const renderers = { overview: renderOverview, facilities: renderFacilities, competitors: renderCompetitors, daily: renderDaily, data: renderDataStatus };
  main.innerHTML = renderers[state.activeTab]?.() || renderOverview();
}
function renderHeader() {
  $("#lastCollected").textContent = state.meta?.latest_collected_at_jst || "—";
  $("#renderedAt").textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
  if (state.meta?.sources_included) $("#sourcesBadge").textContent = state.meta.sources_included.join(" / ");
  if (state.meta?.retention_previous_periods != null) $("#periodPolicyBadge").textContent = `当期間 + 過去${state.meta.retention_previous_periods}期`;
  $("#refreshBtn").disabled = state.loading;
  $("#refreshBtn").textContent = state.loading ? "再読込中…" : "最新データを再読込";
  $("#footer").textContent = `ZMI history only / unified_rows: ${state.meta?.unified_rows ?? state.rows.length} / default_period: ${state.meta?.default_period_key || state.period || "—"}`;
}
function kpi(label, big, delta = "") { return `<article class="kpi-card"><div class="label">${esc(label)}</div><div class="big">${big}</div><div class="delta flat">${esc(delta)}</div></article>`; }
function renderOverview() {
  const rows = filteredRows(); const prevKey = prevPeriod(state.period); const prevRows = prevKey ? filteredRows(prevKey) : [];
  const avg = avgPrice(rows), prevAvg = avgPrice(prevRows); const sr = soldRate(rows), prevSr = soldRate(prevRows);
  const props = aggregateByProperty(rows); const prevMap = new Map(aggregateByProperty(prevRows).map((p) => [p.name, p]));
  const rising = props.filter((p) => p.medianPrice != null && prevMap.get(p.name)?.medianPrice != null && p.medianPrice > prevMap.get(p.name).medianPrice).length;
  const compRows = baseRows().filter((r) => isTrue(r.is_room_only_comp)); const compProps = aggregateByProperty(compRows);
  const compObserved = ROOM_ONLY_COMPS.filter((n) => compProps.find((p) => p.name === n && ["available", "sold_out"].includes(p.status))).length;
  const compSold = ROOM_ONLY_COMPS.filter((n) => compProps.find((p) => p.name === n && p.status === "sold_out")).length;
  const daily = aggregateDaily(rows);
  const own = props.filter((p) => p.own).map((p) => `<article class="comp-card"><b>${esc(p.name)}</b><div class="comp-row"><span>OTA販売可否</span>${statusPill(p.status)}</div><div class="comp-row"><span>価格中央値</span><strong>${yen(p.medianPrice)}</strong></div><div class="comp-row"><span>信頼度</span><span>${confPill(p.priceConf)} ${confPill(p.invConf)}</span></div></article>`).join("") || `<div class="empty">自社施設データなし</div>`;
  const level = (sr != null && sr >= 0.4) || compSold >= 2 ? "strong" : (sr != null && sr >= 0.2) || compSold === 1 ? "medium" : "weak";
  return `
    <section class="kpi-grid">
      ${kpi("エリア価格平均", yen(avg), prevAvg ? `前期 ${yen(prevAvg)}` : "前期間データ不足")}
      ${kpi("OTA販売不可日率", pct(sr), prevSr != null ? `前期 ${pct(prevSr)}` : "観測日付ベース")}
      ${kpi("追跡施設数", String(props.length), "表示条件適用後")}
      ${kpi("価格上昇施設数", String(rising), "前期間比")}
      ${kpi("重点競合カバレッジ", `${compObserved}/${ROOM_ONLY_COMPS.length}`, `sold_out ${compSold}`)}
      ${kpi("最終データ取得", shortTs(state.meta?.latest_collected_at_jst), "JST")}
    </section>
    <section class="signal"><b>判断シグナル:</b> 在庫KPI → 価格KPIの順で判断。選択期間のOTA販売不可日率 ${pct(sr)}、重点競合 sold_out ${compSold}/${compObserved} → 在庫圧 ${level}。喜らく/三浦屋はPMS実在庫ではなくOTA販売可否との比較で見る。</section>
    <section class="panel-grid">
      ${chartPanel({
        title: "エリア価格推移",
        description: "選択期間における蔵王温泉エリアのOTA表示価格の推移（各施設のOTA表示価格中央値を、チェックイン日ごとに平均した値）。",
        metric: "OTA表示価格中央値の日次平均",
        xLabel: "チェックイン日",
        yLabel: "表示価格（円）",
        unit: "円",
        granularity: "チェックイン日（日次）",
        legend: `<div class="legend"><span><i class="dot" style="background:var(--blue)"></i>OTA表示価格（円）</span></div>`,
        svg: lineChart(daily.map((d) => ({ x: d.checkin, y: d.avg })))
      })}
      ${chartPanel({
        title: "OTA販売可否構成の推移",
        description: "選択期間のチェックイン日ごとに、観測施設のOTA販売可否（available / sold_out / 観測なし）の構成を積み上げ表示。PMS実在庫ではなくOTA上の販売可否です。",
        metric: "OTA販売可否の施設数構成",
        xLabel: "チェックイン日",
        yLabel: "観測施設数（件）",
        unit: "件",
        granularity: "チェックイン日（日次）",
        legend: `<div class="legend"><span><i class="dot" style="background:var(--green)"></i>販売可（available）</span><span><i class="dot" style="background:var(--red)"></i>販売不可（sold_out）</span><span><i class="dot" style="background:#cbd5e1"></i>観測なし</span></div>`,
        svg: stackChart(daily)
      })}
    </section>
    <section class="panel"><h2>自社施設ショートカード</h2><p class="chart-desc">自社施設（三浦屋 / 喜らく）の選択期間サマリー。喜らくは全OTA（じゃらん 喜らく / Booking ZAO SPA HOTEL Kiraku）を同一施設に統合済み。</p><div class="comp-grid">${own}</div></section>`;
}
function renderFacilities() {
  const props = aggregateByProperty(filteredRows()).sort((a, b) => (b.medianPrice || 0) - (a.medianPrice || 0));
  const prevMap = new Map(aggregateByProperty(prevPeriod(state.period) ? filteredRows(prevPeriod(state.period)) : []).map((p) => [p.name, p]));
  if (!props.length) return `<section class="panel"><div class="empty">条件に一致する施設がありません</div></section>`;
  const rows = props.map((p) => facilityRow(p, prevMap.get(p.name))).join("");
  const cards = props.map((p) => facilityCard(p, prevMap.get(p.name))).join("");
  return `<section class="panel">
    <h2>施設別サマリー</h2>
    <p class="chart-desc">選択期間における施設別のOTA表示価格・販売可否の集計。価格は各施設の素泊まり相当かつ2人用標準部屋（Booking=室料想定 / じゃらん=素泊まり確定 ＋ ツイン/ダブル等）のOTA表示価格中央値（円）。「前期間比」は中央値の増減率（%）。価格信頼度は読取品質（basis）×多ソース照合（coverage）の総合。</p>
    <table class="desktop-table">
      ${tableCaption("施設別サマリー", "施設別のOTA表示価格中央値（素泊まり・2人用標準部屋）・OTA販売可否・観測ソース数・価格信頼度（総合/読取/カバレッジ）・食事/部屋タイプ内訳", props.length)}
      <thead><tr><th>施設名</th><th>OTA販売可否</th><th>表示価格中央値（円）</th><th>前期間比（%）</th><th>観測ソース数（件）</th><th>価格信頼度（総合/読取/ｶﾊﾞﾚｯｼﾞ）</th><th>素泊まり価格件数</th><th>2人用部屋価格件数</th><th>食事込み除外/不明（件）</th><th>部屋タイプ除外/不明（件）</th><th>在庫信頼度</th><th>最終観測（JST）</th><th>価格推移</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="mobile-cards">${cards}</div>
  </section>`;
}
function deltaText(p, prev) {
  if (p.medianPrice == null || prev?.medianPrice == null || prev.medianPrice <= 0) return { text: "—", cls: "flat" };
  const d = (p.medianPrice - prev.medianPrice) / prev.medianPrice;
  return { text: `${d >= 0 ? "▲" : "▼"} ${(Math.abs(d) * 100).toFixed(1)}%`, cls: d > 0 ? "up" : d < 0 ? "down" : "flat" };
}
function sparkVals(name) { return state.rows.filter((r) => r.canonical_property_name === name).sort((a, b) => a.checkin.localeCompare(b.checkin)).map((r) => num(r.median_directional_price)); }
function facilityRow(p, prev) {
  const d = deltaText(p, prev); const labels = `${p.own ? `<span class="badge badge-blue">自社</span>` : ""}${p.comp ? `<span class="badge badge-purple">重点</span>` : ""}`;
  return `<tr><td><div class="rowname">${esc(p.name)}</div><div class="chips">${labels}<span class="chip">${esc(p.tier || "tier不明")}</span></div></td><td>${statusPill(p.status)}</td><td><strong>${yen(p.medianPrice)}</strong></td><td class="${d.cls}" style="font-weight:900">${d.text}</td><td>${p.srcMax}</td><td>${confPill(p.priceConf)} / ${confPill(p.basisConf)} / ${confPill(p.coverageConf)}</td><td>${p.roomOnlySamples}</td><td>${p.twoPersonSamples}</td><td>${p.excludedMealSamples} / ${p.unknownMealCount}</td><td>${p.excludedRoomTypeSamples} / ${p.unknownRoomCount}</td><td>${confPill(p.invConf)}</td><td>${shortTs(p.latest)}</td><td>${spark(sparkVals(p.name))}</td></tr>`;
}
function facilityCard(p, prev) {
  const d = deltaText(p, prev);
  return `<details class="facility-card"><summary><div class="fc-top"><div><div class="fc-name">${esc(p.name)}</div><div class="chips">${p.own ? `<span class="badge badge-blue">自社</span>` : ""}${p.comp ? `<span class="badge badge-purple">重点</span>` : ""}</div></div>${statusPill(p.status)}</div><div class="fc-grid"><div><div class="k">価格中央値（素泊まり相当）</div><strong>${yen(p.medianPrice)}</strong></div><div><div class="k">前期間比</div><strong class="${d.cls}">${d.text}</strong></div><div><div class="k">source</div>${p.srcMax}</div><div><div class="k">価格信頼度(総合)</div>${confPill(p.priceConf)}</div></div></summary><div class="fc-grid"><div><div class="k">読取/ｶﾊﾞﾚｯｼﾞ</div>${confPill(p.basisConf)} ${confPill(p.coverageConf)}</div><div><div class="k">素泊まり価格件数</div>${p.roomOnlySamples}</div><div><div class="k">2人用部屋価格件数</div>${p.twoPersonSamples}</div><div><div class="k">食事込み除外/不明</div>${p.excludedMealSamples} / ${p.unknownMealCount}</div><div><div class="k">部屋タイプ除外/不明</div>${p.excludedRoomTypeSamples} / ${p.unknownRoomCount}</div><div><div class="k">在庫信頼度</div>${confPill(p.invConf)}</div><div><div class="k">観測日数</div>${p.days}</div><div><div class="k">sold_out日数</div>${p.soldDays}</div><div><div class="k">available日数</div>${p.availableDays}</div><div><div class="k">取得</div>${shortTs(p.latest)}</div></div></details>`;
}
function renderCompetitors() {
  const props = aggregateByProperty(baseRows().filter((r) => isTrue(r.is_room_only_comp)));
  const cards = ROOM_ONLY_COMPS.map((name) => {
    const p = props.find((x) => x.name === name);
    if (!p) return `<article class="comp-card"><b>${COMP_LABEL[name]}</b><div class="empty">観測なし</div></article>`;
    return `<article class="comp-card"><b>${COMP_LABEL[name]}</b><div class="comp-row"><span>OTA販売可否</span>${statusPill(p.status)}</div><div class="comp-row"><span>価格中央値</span><strong>${yen(p.medianPrice)}</strong></div><div class="comp-row"><span>source</span><strong>${p.srcMax}</strong></div><div class="comp-row"><span>信頼度</span><span>${confPill(p.priceConf)} ${confPill(p.invConf)}</span></div><div class="comp-row"><span>読取/ｶﾊﾞﾚｯｼﾞ</span><span>${confPill(p.basisConf)} ${confPill(p.coverageConf)}</span></div><div class="comp-row"><span>2人用価格件数</span><strong>${p.twoPersonSamples}</strong></div><div class="comp-row"><span>部屋除外/不明</span><strong>${p.excludedRoomTypeSamples} / ${p.unknownRoomCount}</strong></div><div class="comp-row"><span>sold_out日数</span><strong>${p.soldDays}/${p.days}</strong></div></article>`;
  }).join("");
  return `<section class="panel">
    <h2>重点競合（HAMMOND / OAKHILL / 吉田屋）</h2>
    <p class="chart-desc">素泊まり競合のOTA販売可否・OTA表示価格中央値（円）・期間内 sold_out 日数。PMS実在庫ではなくOTA観測です。対象期間: ${esc(periodText())} ／ source: ${esc(srcLabel())}</p>
    <div class="comp-grid">${cards}</div>
  </section>`;
}
function renderDaily() {
  const daily = aggregateDaily(filteredRows());
  const cells = daily.map((d) => `<div class="heat-cell" style="background:${heatColor(d.rate)}">${esc(d.checkin.slice(5))}<small>${pct(d.rate)}</small><small>A:${d.avail} S:${d.sold} N:${d.nodata}</small></div>`).join("");
  const tableRows = daily.map((d) => `<tr><td>${esc(d.checkin)}</td><td>${pct(d.rate)}</td><td>${d.avail}</td><td>${d.sold}</td><td>${d.nodata}</td><td>${yen(d.avg)}</td></tr>`).join("");
  return `<section class="panel">
    <h2>日別観測データ</h2>
    <p class="chart-desc">チェックイン日ごとのOTA販売不可日率（%）と販売可否の観測施設数（件）、OTA表示価格中央値の日次平均（円）。「OTA販売不可日率」= sold_out /(available + sold_out)。色が濃い（赤寄り）ほど販売不可が多い。</p>
    ${axisBlock("チェックイン日", "OTA販売不可日率（%）")}
    <div class="heat" aria-label="日別 OTA販売不可日率ヒートマップ">${cells || `<div class="empty">日別データなし</div>`}</div>
    <p class="chart-cap">凡例: 各セル＝チェックイン日 ／ %＝OTA販売不可日率 ／ A=販売可 S=販売不可 N=観測なし（件） ／ 集計粒度: 日次 ／ 対象期間: ${esc(periodText())} ／ source: ${esc(srcLabel())}</p>
    <table class="desktop-table">
      ${tableCaption("日別観測明細", "チェックイン日別のOTA販売不可日率・販売可否件数・表示価格中央値の日次平均", daily.length)}
      <thead><tr><th>チェックイン日</th><th>OTA販売不可日率（%）</th><th>販売可（件）</th><th>販売不可（件）</th><th>観測なし（件）</th><th>表示価格（円）</th></tr></thead>
      <tbody>${tableRows || ""}</tbody>
    </table>
    <div class="mobile-cards">${daily.map((d) => `<div class="facility-card"><div class="fc-top"><div class="fc-name">${esc(d.checkin)}</div><span class="status-pill ${d.rate != null && d.rate >= 0.4 ? "status-sold_out" : "status-available"}">${pct(d.rate)}</span></div><div class="fc-grid"><div><div class="k">販売可（件）</div>${d.avail}</div><div><div class="k">販売不可（件）</div>${d.sold}</div><div><div class="k">観測なし（件）</div>${d.nodata}</div><div><div class="k">表示価格（円）</div>${yen(d.avg)}</div></div></div>`).join("") || `<div class="empty">日別データなし</div>`}</div>
  </section>`;
}
function renderDataStatus() {
  const meta = state.meta || {}; const keys = ["generated_at_jst", "latest_collected_at_jst", "history_rows_total", "latest_observation_rows", "unified_rows", "unified_rows_before_retention", "distinct_properties", "distinct_checkins", "sources_included", "data_policy", "period_retention_policy", "current_period_key_jst", "default_period_key", "retention_previous_periods", "retained_period_keys", "dropped_past_period_keys_count", "dropped_past_rows_count"];
  return `<section class="panel"><h2>データ状態</h2><p class="chart-desc">公開データ（metadata.json）の内容。対象期間の保持方針・行数・統合ソース等。喜らくは全OTAを同一施設に統合済み。</p><dl class="kv">${keys.map((k) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(meta[k]) ? meta[k].join(", ") : meta[k] ?? "—")}</dd>`).join("")}</dl></section>`;
}

function syncControls() {
  $("#periodSelect").value = state.period;
  $("#groupSelect").value = state.group;
  $("#confSelect").value = state.confidence;
  $("#searchInput").value = state.search;
}
function readUrlState() {
  const p = new URLSearchParams(location.search);
  state.activeTab = p.get("tab") || state.activeTab;
  state.group = p.get("group") || state.group;
  state.confidence = p.get("confidence") || state.confidence;
  state.search = p.get("q") || state.search;
}
function syncUrlState() {
  const p = new URLSearchParams();
  if (state.activeTab !== "overview") p.set("tab", state.activeTab);
  if (state.period) p.set("period", state.period);
  if (state.group !== "all") p.set("group", state.group);
  if (state.confidence !== "all") p.set("confidence", state.confidence);
  if (state.search) p.set("q", state.search);
  history.replaceState(null, "", `${location.pathname}${p.toString() ? `?${p}` : ""}`);
}
function initPeriods() {
  const keys = periodKeys(); const sel = $("#periodSelect"); sel.innerHTML = "";
  keys.forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = periodLabel(k); sel.appendChild(o); });
  state.period = pickDefaultPeriodKey(keys);
}
function showToast(message) {
  const t = $("#toast"); t.textContent = message; t.hidden = false;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { t.hidden = true; }, 1800);
}
async function loadData({ force = false } = {}) {
  state.loading = true; state.error = ""; render();
  try {
    const bust = force ? Date.now() : "initial";
    const [metaRes, csvRes] = await Promise.all([fetch(`data/metadata.json?v=${bust}`), fetch(`data/zmi_market_unified.csv?v=${bust}`)]);
    if (!csvRes.ok) throw new Error(`CSV fetch failed: ${csvRes.status}`);
    state.meta = metaRes.ok ? await metaRes.json() : null;
    state.rows = parseCSV(await csvRes.text());
    readUrlState(); initPeriods(); syncControls(); syncUrlState(); showToast(force ? "最新データを再読込しました" : "データを読み込みました");
  } catch (err) {
    state.error = `データ読込に失敗しました: ${err.message}`;
  } finally {
    state.loading = false; render();
  }
}
function resetFilters() {
  state.activeTab = "overview"; state.group = "all"; state.confidence = "all"; state.search = ""; state.period = pickDefaultPeriodKey(periodKeys()); syncControls(); syncUrlState(); render();
}
function exportVisibleCsv() {
  const props = aggregateByProperty(filteredRows());
  const header = ["property", "status", "median_price", "avg_price", "source_count", "price_confidence", "inventory_confidence", "latest_collected_at_jst"];
  const lines = [header.join(",")].concat(props.map((p) => [p.name, p.status, p.medianPrice ?? "", p.avgPrice ?? "", p.srcMax, p.priceConf, p.invConf, p.latest].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `zmi_bi_visible_${new Date().toISOString().slice(0,16).replace(/[-:T]/g,"")}.csv`; a.click(); URL.revokeObjectURL(a.href);
}
async function copyStateUrl() {
  syncUrlState(); await navigator.clipboard.writeText(location.href); showToast("表示条件URLをコピーしました");
}
function bindEvents() {
  $("#refreshBtn").addEventListener("click", () => loadData({ force: true }));
  $("#resetBtn").addEventListener("click", resetFilters);
  $("#exportVisibleBtn").addEventListener("click", exportVisibleCsv);
  $("#copyStateBtn").addEventListener("click", copyStateUrl);
  $("#periodSelect").addEventListener("change", (e) => { state.period = e.target.value; syncUrlState(); render(); });
  $("#groupSelect").addEventListener("change", (e) => { state.group = e.target.value; syncUrlState(); render(); });
  $("#confSelect").addEventListener("change", (e) => { state.confidence = e.target.value; syncUrlState(); render(); });
  $("#searchInput").addEventListener("input", (e) => { state.search = e.target.value; syncUrlState(); render(); });
  $$("[data-tab]").forEach((btn) => btn.addEventListener("click", () => { state.activeTab = btn.dataset.tab; syncUrlState(); render(); }));
}

bindEvents();
loadData();
