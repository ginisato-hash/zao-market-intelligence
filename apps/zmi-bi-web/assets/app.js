/* ZMI BI Web v3 — unified-source dashboard.
 * Reads data/zmi_market_unified.csv + data/metadata.json (already source-unified
 * AND period-retained by the export step). No source selector, no CSV upload,
 * no fake links. Vanilla JS only, no external CDN. Mobile-first responsive. */

const ROOM_ONLY_COMPS = ["HAMMOND", "ONSEN & STAY OAKHILL", "吉田屋"];
const COMP_LABEL = { "HAMMOND": "HAMMOND", "ONSEN & STAY OAKHILL": "OAKHILL", "吉田屋": "吉田屋" };
const GROUP_TIER = { anchor: "tier_anchor_high", mid: "tier_direct_mid", budget: "tier_budget_small" };

const state = {
  rows: [], meta: null, activeTab: "overview",
  period: "", group: "all", confidence: "all", search: "",
  loading: false, error: ""
};

/* ---------- utils ---------- */
const $ = (s) => document.querySelector(s);
const yen = (n) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("ja-JP") + " 円");
const pct = (n) => (n == null || Number.isNaN(n) ? "—" : (n * 100).toFixed(1) + "%");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isTrue = (v) => String(v).toLowerCase() === "true";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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

/* ---------- periods ---------- */
function comparePeriod(a, b) {
  const r = (k) => k.slice(0, 7) + (k.endsWith("_early") ? "0" : "1");
  return r(a) < r(b) ? -1 : r(a) > r(b) ? 1 : 0;
}
function sortPeriodKeys(keys) { return [...new Set(keys)].sort(comparePeriod); }
function getCurrentPeriodKeyJst(date = new Date()) {
  const jst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const day = Number(jst.slice(8, 10));
  return `${jst.slice(0, 7)}_${day <= 15 ? "early" : "late"}`;
}
function pickDefaultPeriodKey(keys, currentKey) {
  if (!keys.length) return "";
  if (keys.includes(currentKey)) return currentKey;
  const fut = keys.find((k) => comparePeriod(k, currentKey) > 0);
  return fut || keys[keys.length - 1];
}
function periodLabel(key) {
  const r = state.rows.find((x) => x.period_key === key);
  if (r && r.period_label) return r.period_label;
  const [ym, half] = key.split("_");
  return `${(ym || "").slice(0, 4)}年${Number((ym || "").slice(5, 7))}月 ${half === "early" ? "上旬" : "下旬"}`;
}
function periodKeys() { return sortPeriodKeys(state.rows.map((r) => r.period_key)); }

/* ---------- filters & aggregation ---------- */
function applyGroup(rows) {
  if (state.group === "own") return rows.filter((r) => isTrue(r.is_own_property));
  if (state.group === "room_comp") return rows.filter((r) => isTrue(r.is_room_only_comp));
  if (GROUP_TIER[state.group]) return rows.filter((r) => r.tier === GROUP_TIER[state.group]);
  return rows;
}
function rankConf(c) { return c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0; }
function applyConfidence(rows) {
  if (state.confidence === "all") return rows;
  if (state.confidence === "high") return rows.filter((r) => r.inventory_confidence === "high" || r.price_confidence === "high");
  if (state.confidence === "medium_or_high") return rows.filter((r) => rankConf(r.inventory_confidence) >= 2 || rankConf(r.price_confidence) >= 2);
  if (state.confidence === "low") return rows.filter((r) => r.inventory_confidence === "low" && r.price_confidence === "low");
  return rows;
}
function applySearch(rows) {
  const q = state.search.trim().toLowerCase();
  return q ? rows.filter((r) => r.canonical_property_name.toLowerCase().includes(q)) : rows;
}
function periodRows(key = state.period) { return state.rows.filter((r) => r.period_key === key); }
function filteredRows(key = state.period) { return applySearch(applyConfidence(applyGroup(periodRows(key)))); }

function aggregateByProperty(rows) {
  const m = new Map();
  rows.forEach((r) => {
    const k = r.canonical_property_name;
    const e = m.get(k) || { name: k, tier: r.tier, prices: [], statuses: [], srcMax: 0, latest: "", priceConf: "low", invConf: "low", comp: isTrue(r.is_room_only_comp), own: isTrue(r.is_own_property), soldDays: 0, days: 0 };
    const p = num(r.median_directional_price); if (p != null && p > 0) e.prices.push(p);
    e.statuses.push(r.unified_availability_status);
    e.srcMax = Math.max(e.srcMax, num(r.source_count) || 0);
    if (r.latest_collected_at_jst > e.latest) e.latest = r.latest_collected_at_jst;
    if (rankConf(r.price_confidence) > rankConf(e.priceConf)) e.priceConf = r.price_confidence;
    if (rankConf(r.inventory_confidence) > rankConf(e.invConf)) e.invConf = r.inventory_confidence;
    if (r.unified_availability_status === "sold_out") e.soldDays++;
    if (r.unified_availability_status === "available" || r.unified_availability_status === "sold_out") e.days++;
    m.set(k, e);
  });
  return [...m.values()].map((e) => ({
    ...e,
    medianPrice: e.prices.length ? Math.round([...e.prices].sort((a, b) => a - b)[Math.floor(e.prices.length / 2)]) : null,
    status: e.statuses.includes("available") ? "available" : e.statuses.includes("sold_out") ? "sold_out" : e.statuses.includes("not_found") ? "not_found" : "excluded"
  }));
}
function aggregateDaily(rows) {
  const m = new Map();
  rows.forEach((r) => {
    const e = m.get(r.checkin) || { checkin: r.checkin, prices: [], avail: 0, sold: 0, nodata: 0 };
    const p = num(r.median_directional_price); if (p != null && p > 0) e.prices.push(p);
    if (r.unified_availability_status === "available") e.avail++;
    else if (r.unified_availability_status === "sold_out") e.sold++;
    else e.nodata++;
    m.set(r.checkin, e);
  });
  return [...m.values()].sort((a, b) => a.checkin.localeCompare(b.checkin)).map((e) => ({
    checkin: e.checkin, avg: e.prices.length ? Math.round(e.prices.reduce((a, b) => a + b, 0) / e.prices.length) : null,
    avail: e.avail, sold: e.sold, nodata: e.nodata, rate: (e.avail + e.sold) === 0 ? null : e.sold / (e.avail + e.sold)
  }));
}
function areaAvgPrice(rows) { const ps = rows.map((r) => num(r.median_directional_price)).filter((n) => n != null && n > 0); return ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null; }
function soldOutRate(rows) { let a = 0, s = 0; rows.forEach((r) => { if (r.unified_availability_status === "available") a++; else if (r.unified_availability_status === "sold_out") s++; }); return (a + s) === 0 ? null : s / (a + s); }
function prevPeriod(key) { const k = periodKeys(); const i = k.indexOf(key); return i > 0 ? k[i - 1] : null; }

/* ---------- svg helpers ---------- */
function lineChart(data, h = 200) {
  const pts = data.filter((d) => d.y != null);
  const w = 600, pad = 32;
  if (!pts.length) return `<div class="empty">価格データなし</div>`;
  const ys = pts.map((d) => d.y), min = Math.min(...ys), max = Math.max(...ys);
  const X = (i) => pad + (i * (w - pad * 2)) / Math.max(1, pts.length - 1);
  const Y = (v) => h - pad - ((v - min) / Math.max(1, max - min)) * (h - pad * 2);
  const poly = pts.map((d, i) => `${X(i).toFixed(1)},${Y(d.y).toFixed(1)}`).join(" ");
  const dots = pts.map((d, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(d.y).toFixed(1)}" r="3" fill="var(--blue)"/>`).join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"><polyline points="${poly}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round"/>${dots}</svg>`;
}
function stackChart(daily, h = 200) {
  if (!daily.length) return `<div class="empty">データなし</div>`;
  const w = 600, pad = 22, bw = (w - pad * 2) / daily.length;
  let bars = "";
  daily.forEach((d, i) => {
    const tot = d.avail + d.sold + d.nodata || 1; let y = h - pad; const x = pad + i * bw;
    [["#16a34a", d.avail], ["#ef4444", d.sold], ["#cbd5e1", d.nodata]].forEach(([c, v]) => {
      const sh = (v / tot) * (h - pad * 2); y -= sh;
      bars += `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${sh.toFixed(1)}" fill="${c}"/>`;
    });
  });
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${bars}</svg>`;
}
function spark(vals) {
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return `<span class="flat">—</span>`;
  const w = 96, h = 26, min = Math.min(...v), max = Math.max(...v);
  const pts = v.map((y, i) => `${(i * w) / (v.length - 1)},${(h - ((y - min) / Math.max(1, max - min)) * (h - 6) - 3)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function heatColor(v) { if (v == null) return "#f1f3f5"; const hue = 120 - Math.min(1, v) * 120; return `hsl(${hue} 75% 88%)`; }
function statusPill(s) { return `<span class="status-pill status-${s}">${s === "available" ? "OTA販売可" : s === "sold_out" ? "OTA販売不可" : s === "no_data" ? "観測なし" : s}</span>`; }
function confPill(c) { return `<span class="confidence-pill confidence-${c}">${c}</span>`; }

/* ---------- render ---------- */
function render() {
  renderHeader();
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.activeTab));
  const banner = $("#errorBanner");
  if (state.error) { banner.hidden = false; banner.textContent = state.error; } else banner.hidden = true;
  const main = $("#main");
  if (!state.rows.length) { main.innerHTML = `<div class="panel"><div class="empty">${state.loading ? "読込中…" : "公開データがありません（data/zmi_market_unified.csv を生成してください）"}</div></div>`; return; }
  ({ overview: renderOverview, facilities: renderFacilities, competitors: renderCompetitors, daily: renderDaily, data: renderDataStatus }[state.activeTab] || renderOverview)(main);
}

function renderHeader() {
  $("#lastCollected").textContent = state.meta ? (state.meta.latest_collected_at_jst || "—") : "—";
  $("#renderedAt").textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
  if (state.meta && state.meta.sources_included) $("#sourcesBadge").textContent = state.meta.sources_included.map((s) => s[0].toUpperCase() + s.slice(1)).join(" / ");
  $("#refreshBtn").disabled = state.loading;
}

function kpiCard(label, big, delta, cls) { return `<div class="kpi-card"><div class="label">${label}</div><div class="big">${big}</div><div class="delta ${cls || "flat"}">${delta || ""}</div></div>`; }

function renderKpis(rows, prevRows) {
  const avg = areaAvgPrice(rows), pAvg = areaAvgPrice(prevRows);
  let avgD = "前期間データ不足", avgCls = "flat";
  if (avg != null && pAvg) { const d = (avg - pAvg) / pAvg; avgD = (d >= 0 ? "▲ " : "▼ ") + pct(Math.abs(d)) + "（前期間比）"; avgCls = d > 0 ? "up" : d < 0 ? "down" : "flat"; }
  const sr = soldOutRate(rows), pSr = soldOutRate(prevRows);
  let srD = "前期間データ不足", srCls = "flat";
  if (sr != null && pSr != null) { const d = sr - pSr; srD = (d >= 0 ? "▲ " : "▼ ") + pct(Math.abs(d)) + "pt"; srCls = d > 0 ? "up" : d < 0 ? "down" : "flat"; }
  const props = aggregateByProperty(rows), pProps = new Map(aggregateByProperty(prevRows).map((p) => [p.name, p]));
  let rising = 0; props.forEach((p) => { const pp = pProps.get(p.name); if (p.medianPrice != null && pp && pp.medianPrice != null && p.medianPrice > pp.medianPrice) rising++; });
  const comp = compStats();
  return `<div class="kpi-grid">
    ${kpiCard("エリア価格中央値", yen(avg), avgD, avgCls)}
    ${kpiCard("OTA販売不可日率", pct(sr), srD, srCls)}
    ${kpiCard("追跡施設数", String(props.length), "統合後の施設数", "flat")}
    ${kpiCard("価格上昇施設数", String(rising), "前期間比", "flat")}
    ${kpiCard("重点競合カバレッジ", `${comp.observed}/${ROOM_ONLY_COMPS.length}`, `OTA販売不可 ${comp.sold}`, "flat")}
    ${kpiCard("最終データ取得", shortTs(state.meta ? state.meta.latest_collected_at_jst : ""), "JST", "flat")}
  </div>`;
}
function compStats() {
  const rows = periodRows().filter((r) => isTrue(r.is_room_only_comp));
  const byName = aggregateByProperty(rows);
  let sold = 0, observed = 0;
  ROOM_ONLY_COMPS.forEach((n) => { const e = byName.find((x) => x.name === n); if (!e) return; if (e.status === "available") observed++; else if (e.status === "sold_out") { observed++; sold++; } });
  return { sold, observed, byName };
}
function signalText() {
  const rows = filteredRows(); const sr = soldOutRate(rows); const c = compStats();
  let level = "weak", conf = c.observed >= 3 ? "high" : c.observed >= 2 ? "medium" : "low";
  if ((sr != null && sr >= 0.4) || c.sold >= 2) level = "strong"; else if ((sr != null && sr >= 0.2 && sr < 0.4) || c.sold === 1) level = "medium";
  const kir = level === "strong" ? "hold_or_raise（OTA販売不可が多い＝強気維持）" : level === "medium" ? "hold（様子見）" : conf === "low" ? "monitor_or_hold（弱いが低カバレッジ・値下げ断定回避）" : "competitive_or_discount（軟調）";
  const miu = level === "strong" ? "raise_or_hold（こぼれ需要取り込み）" : level === "medium" ? "hold（据え置き）" : conf === "low" ? "monitor_or_hold（低カバレッジ・過度な値下げ回避）" : "discount_to_fill（充填優先）";
  return `在庫KPI → 価格KPIの順で判断。エリアOTA販売不可日率 <b>${pct(sr)}</b>、重点競合 OTA販売不可 <b>${c.sold}/${c.observed}</b>（confidence ${conf}）→ 在庫圧 <b>${level}</b>。喜らく: ${esc(kir)} / 三浦屋: ${esc(miu)}`;
}

function renderOverview(main) {
  const rows = filteredRows(); const prev = prevPeriod(state.period); const prevRows = prev ? applySearch(applyConfidence(applyGroup(periodRows(prev)))) : [];
  const daily = aggregateDaily(rows);
  const own = aggregateByProperty(periodRows().filter((r) => isTrue(r.is_own_property)));
  main.innerHTML = `
    ${renderKpis(rows, prevRows)}
    <div class="signal"><b>三浦屋・喜らく向けシグナル</b><br/>${signalText()}</div>
    <div class="panel-grid">
      <div class="panel"><h2>エリア価格推移（統合中央値の日次平均）</h2><div class="legend"><span><i class="dot" style="background:var(--blue)"></i>エリア平均価格</span></div>${lineChart(daily.map((d) => ({ x: d.checkin, y: d.avg })))}</div>
      <div class="panel"><h2>OTA販売不可日率（日別）</h2><div class="legend"><span><i class="dot" style="background:var(--green)"></i>販売可</span><span><i class="dot" style="background:var(--red)"></i>販売不可</span><span><i class="dot" style="background:#cbd5e1"></i>観測なし</span></div>${stackChart(daily)}</div>
    </div>
    <div class="panel"><h2>自社施設ショートカード</h2>${own.length ? `<div class="shortcards">${own.map((p) => `<div class="facility-card"><div class="fc-top"><span class="fc-name">${esc(p.name)} 🏠</span>${statusPill(p.status)}</div><div class="fc-grid"><div><span class="k">価格中央値</span><div>${yen(p.medianPrice)}</div></div><div><span class="k">src</span><div>${p.srcMax}</div></div><div><span class="k">価格信頼度</span><div>${confPill(p.priceConf)}</div></div><div><span class="k">在庫信頼度</span><div>${confPill(p.invConf)}</div></div></div></div>`).join("")}</div>` : `<div class="empty">自社施設の観測がこの期間にありません</div>`}</div>`;
}

function facilityRowsSorted() { return aggregateByProperty(filteredRows()).sort((a, b) => (b.medianPrice || 0) - (a.medianPrice || 0)); }
function deltaFor(p, prevMap) {
  const pp = prevMap.get(p.name);
  if (p.medianPrice != null && pp && pp.medianPrice != null && pp.medianPrice > 0) { const d = (p.medianPrice - pp.medianPrice) / pp.medianPrice; return { txt: (d >= 0 ? "▲ " : "▼ ") + pct(Math.abs(d)), cls: d > 0 ? "up" : d < 0 ? "down" : "flat" }; }
  return { txt: "—", cls: "flat" };
}
function renderFacilities(main) {
  const props = facilityRowsSorted();
  const prev = prevPeriod(state.period); const prevMap = new Map(aggregateByProperty(prev ? periodRows(prev) : []).map((p) => [p.name, p]));
  if (!props.length) { main.innerHTML = `<div class="panel"><div class="empty">条件に合う施設がありません</div></div>`; return; }
  const sparkFor = (name) => spark(state.rows.filter((r) => r.canonical_property_name === name).sort((a, b) => a.checkin.localeCompare(b.checkin)).map((r) => num(r.median_directional_price)));
  const rowsHtml = props.map((p) => { const d = deltaFor(p, prevMap); return `<tr><td class="rowname">${esc(p.name)}${p.own ? " 🏠" : p.comp ? " ⭐" : ""}<div class="flat">${esc(p.tier)}</div></td><td>${statusPill(p.status)}</td><td><b>${yen(p.medianPrice)}</b></td><td class="${d.cls}">${d.txt}</td><td>${p.srcMax}</td><td>${confPill(p.priceConf)}</td><td>${confPill(p.invConf)}</td><td class="flat">${shortTs(p.latest)}</td><td>${sparkFor(p.name)}</td></tr>`; }).join("");
  const cardsHtml = props.map((p) => { const d = deltaFor(p, prevMap); return `<div class="facility-card"><div class="fc-top"><span class="fc-name">${esc(p.name)}${p.own ? " 🏠" : p.comp ? " ⭐" : ""}</span>${statusPill(p.status)}</div><div class="fc-grid"><div><span class="k">価格中央値</span><div><b>${yen(p.medianPrice)}</b></div></div><div><span class="k">前期間比</span><div class="${d.cls}">${d.txt}</div></div><div><span class="k">source_count</span><div>${p.srcMax}</div></div><div><span class="k">取得</span><div>${shortTs(p.latest)}</div></div><div><span class="k">価格信頼度</span><div>${confPill(p.priceConf)}</div></div><div><span class="k">在庫信頼度</span><div>${confPill(p.invConf)}</div></div></div><div style="margin-top:8px">${sparkFor(p.name)}</div></div>`; }).join("");
  main.innerHTML = `<div class="panel"><h2>施設別 価格変化とOTA販売可否（全ソース統合）</h2>
    <table class="desktop-table"><thead><tr><th>施設</th><th>OTA販売可否</th><th>価格中央値</th><th>前期間比</th><th>src</th><th>価格信頼度</th><th>在庫信頼度</th><th>取得時刻</th><th>推移</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    <div class="mobile-cards">${cardsHtml}</div></div>`;
}

function renderCompetitors(main) {
  const rows = periodRows().filter((r) => isTrue(r.is_room_only_comp));
  const byName = aggregateByProperty(rows);
  const cards = ROOM_ONLY_COMPS.map((name) => {
    const e = byName.find((x) => x.name === name);
    const status = e ? e.status : "no_data";
    return `<div class="comp-card"><div class="fc-top"><b>${COMP_LABEL[name]}</b>${statusPill(status)}</div>
      <div class="row"><span>価格中央値</span><span>${e ? yen(e.medianPrice) : "—"}</span></div>
      <div class="row"><span>source_count</span><span>${e ? e.srcMax : 0}</span></div>
      <div class="row"><span>価格信頼度</span><span>${e ? confPill(e.priceConf) : "—"}</span></div>
      <div class="row"><span>在庫信頼度</span><span>${e ? confPill(e.invConf) : "—"}</span></div>
      <div class="row"><span>期間内 OTA販売不可日数</span><span>${e ? e.soldDays : 0} / ${e ? e.days : 0}</span></div></div>`;
  }).join("");
  const c = compStats();
  main.innerHTML = `<div class="panel"><h2>重点競合（HAMMOND / OAKHILL / 吉田屋）</h2><div class="comp-grid">${cards}</div>
    <p class="flat" style="margin-top:12px">カバレッジ: ${c.observed}/${ROOM_ONLY_COMPS.length} 観測、うち OTA販売不可 ${c.sold}。観測なしは collection ローテーション未到達の可能性。</p></div>`;
}

function renderDaily(main) {
  const daily = aggregateDaily(filteredRows());
  if (!daily.length) { main.innerHTML = `<div class="panel"><div class="empty">この期間の日別データがありません</div></div>`; return; }
  const heat = daily.map((d) => `<div class="cell" style="background:${heatColor(d.rate)}">${d.checkin.slice(5)}<small>${d.rate == null ? "—" : (d.rate * 100).toFixed(0) + "%"}</small></div>`).join("");
  const rows = daily.map((d) => `<tr><td>${d.checkin}</td><td>${d.rate == null ? "—" : pct(d.rate)}</td><td>${d.avail}</td><td>${d.sold}</td><td>${d.nodata}</td><td>${yen(d.avg)}</td></tr>`).join("");
  const cards = daily.map((d) => `<div class="facility-card"><div class="fc-top"><span class="fc-name">${d.checkin}</span><span class="status-pill ${d.rate != null && d.rate >= 0.4 ? "status-sold_out" : "status-available"}">${d.rate == null ? "—" : pct(d.rate)}</span></div><div class="fc-grid"><div><span class="k">販売可</span><div>${d.avail}</div></div><div><span class="k">販売不可</span><div>${d.sold}</div></div><div><span class="k">観測なし</span><div>${d.nodata}</div></div><div><span class="k">平均価格</span><div>${yen(d.avg)}</div></div></div></div>`).join("");
  main.innerHTML = `<div class="panel"><h2>日別 OTA販売不可日率ヒートマップ</h2><div class="heat">${heat}</div></div>
    <div class="panel"><h2>日別 明細</h2>
      <table class="desktop-table"><thead><tr><th>checkin</th><th>OTA販売不可日率</th><th>販売可</th><th>販売不可</th><th>観測なし</th><th>平均価格</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="mobile-cards">${cards}</div></div>`;
}

function renderDataStatus(main) {
  const m = state.meta || {};
  const keys = ["generated_at_jst", "latest_collected_at_jst", "history_rows_total", "latest_observation_rows", "unified_rows", "unified_rows_before_retention", "distinct_properties", "distinct_checkins", "sources_included", "data_policy", "period_retention_policy", "current_period_key_jst", "default_period_key", "retention_previous_periods", "retained_period_keys", "dropped_past_period_keys_count", "dropped_past_rows_count"];
  const fmt = (v) => Array.isArray(v) ? `<div class="chips">${v.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>` : esc(v == null ? "—" : v);
  main.innerHTML = `<div class="panel"><h2>データ状態（metadata.json）</h2><dl class="kv">${keys.map((k) => `<dt>${k}</dt><dd>${fmt(m[k])}</dd>`).join("")}</dl></div>`;
}

/* ---------- toast / errors ---------- */
let toastTimer = null;
function renderToast(message) { const t = $("#toast"); t.textContent = message; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200); }

/* ---------- actions ---------- */
function setTab(tab) { state.activeTab = tab; syncUrlState(); render(); }
function resetFilters() {
  state.group = "all"; state.confidence = "all"; state.search = ""; state.activeTab = "overview";
  state.period = (state.meta && state.meta.default_period_key && periodKeys().includes(state.meta.default_period_key)) ? state.meta.default_period_key : pickDefaultPeriodKey(periodKeys(), getCurrentPeriodKeyJst());
  $("#periodSelect").value = state.period; $("#groupSelect").value = "all"; $("#confSelect").value = "all"; $("#searchInput").value = "";
  history.replaceState(null, "", location.pathname);
  render();
}
function exportVisibleCsv() {
  const props = facilityRowsSorted();
  const head = ["period_key", "canonical_property_name", "ota_status", "median_price", "source_count", "price_confidence", "inventory_confidence", "sold_out_days", "observed_days", "latest_collected_at_jst"];
  const lines = props.map((p) => [state.period, p.name, p.status, p.medianPrice ?? "", p.srcMax, p.priceConf, p.invConf, p.soldDays, p.days, p.latest].map((c) => { const s = String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(","));
  const csv = [head.join(","), ...lines].join("\n") + "\n";
  const now = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date()).replace(/[- :]/g, "").slice(0, 12);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `zmi_bi_visible_${now}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  renderToast("表示中CSVを保存しました");
}
function copyStateUrl() {
  syncUrlState();
  const done = () => renderToast("表示条件URLをコピーしました");
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(done).catch(() => renderToast(location.href));
  else renderToast(location.href);
}

/* ---------- URL state ---------- */
function readUrlState() {
  const q = new URLSearchParams(location.search);
  if (q.get("tab")) state.activeTab = q.get("tab");
  if (q.get("group")) state.group = q.get("group");
  if (q.get("confidence")) state.confidence = q.get("confidence");
  if (q.get("q")) state.search = q.get("q");
  return q.get("period") || "";
}
function syncUrlState() {
  const q = new URLSearchParams();
  q.set("tab", state.activeTab); q.set("period", state.period);
  if (state.group !== "all") q.set("group", state.group);
  if (state.confidence !== "all") q.set("confidence", state.confidence);
  if (state.search.trim()) q.set("q", state.search.trim());
  history.replaceState(null, "", `${location.pathname}?${q.toString()}`);
}

/* ---------- init / load ---------- */
function initPeriods(urlPeriod) {
  const keys = periodKeys();
  const sel = $("#periodSelect"); sel.innerHTML = "";
  keys.forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = periodLabel(k); sel.appendChild(o); });
  let chosen = "";
  if (urlPeriod && keys.includes(urlPeriod)) chosen = urlPeriod;                       // 1. valid URL period
  else if (state.meta && state.meta.default_period_key && keys.includes(state.meta.default_period_key)) chosen = state.meta.default_period_key; // 2. metadata default
  else chosen = pickDefaultPeriodKey(keys, getCurrentPeriodKeyJst());                  // 3-5. current/future/latest
  state.period = chosen; sel.value = chosen;
}

async function loadData({ force = false } = {}) {
  state.loading = true; state.error = ""; renderHeader();
  const bust = force ? Date.now() : "initial";
  try {
    const [metaRes, csvRes] = await Promise.all([
      fetch(`data/metadata.json?v=${bust}`),
      fetch(`data/zmi_market_unified.csv?v=${bust}`)
    ]);
    state.meta = metaRes.ok ? await metaRes.json() : null;
    state.rows = csvRes.ok ? parseCSV(await csvRes.text()) : [];
    if (!state.rows.length) state.error = "公開データ（zmi_market_unified.csv）を読み込めませんでした。";
    if (state.meta && state.meta.data_policy) $("#footer").textContent = `${state.meta.data_policy} ｜ sources: ${(state.meta.sources_included || []).join(" + ")} ｜ unified_rows: ${state.meta.unified_rows} ｜ 保持期間: ${(state.meta.retained_period_keys || []).length}期`;
  } catch (e) {
    state.error = "データ読込に失敗しました: " + (e && e.message ? e.message : String(e));
    state.rows = [];
  }
  state.loading = false;
  return true;
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
  $("#periodSelect").addEventListener("change", (e) => { state.period = e.target.value; syncUrlState(); render(); });
  $("#groupSelect").addEventListener("change", (e) => { state.group = e.target.value; syncUrlState(); render(); });
  $("#confSelect").addEventListener("change", (e) => { state.confidence = e.target.value; syncUrlState(); render(); });
  $("#searchInput").addEventListener("input", (e) => { state.search = e.target.value; syncUrlState(); render(); });
  $("#resetBtn").addEventListener("click", resetFilters);
  $("#exportVisibleBtn").addEventListener("click", exportVisibleCsv);
  $("#copyStateBtn").addEventListener("click", copyStateUrl);
  $("#refreshBtn").addEventListener("click", async () => { await loadData({ force: true }); const keys = periodKeys(); if (!keys.includes(state.period)) initPeriods(state.period); render(); renderToast("最新データを再読込しました"); });
}

(async function start() {
  bindEvents();
  const urlPeriod = readUrlState();
  await loadData();
  if (state.rows.length) {
    initPeriods(urlPeriod);
    $("#groupSelect").value = state.group; $("#confSelect").value = state.confidence; $("#searchInput").value = state.search;
    if (!["overview", "facilities", "competitors", "daily", "data"].includes(state.activeTab)) state.activeTab = "overview";
  }
  render();
})();
