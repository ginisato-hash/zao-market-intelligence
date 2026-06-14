/* ZMI BI Web — unified-source dashboard.
 * Reads apps/zmi-bi-web/data/zmi_market_unified.csv (already source-unified by
 * the export step). NO data source selector — all sources are merged upstream.
 * No external CDN/API; vanilla JS only. */

const ROOM_ONLY_COMPS = ["HAMMOND", "ONSEN & STAY OAKHILL", "吉田屋"];
const COMP_LABEL = { "HAMMOND": "HAMMOND", "ONSEN & STAY OAKHILL": "OAKHILL", "吉田屋": "吉田屋" };

let UNIFIED = [];   // unified rows (one per property×checkin)
let META = null;

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

const yen = (n) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("ja-JP") + " 円");
const pct = (n) => (n == null || Number.isNaN(n) ? "—" : (n * 100).toFixed(1) + "%");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isTrue = (v) => String(v).toLowerCase() === "true";
const setText = (id, v) => { const el = document.querySelector(id); if (el) el.textContent = v; };

function periodLabel(key) {
  const r = UNIFIED.find((x) => x.period_key === key);
  return r ? r.period_label : key;
}
function periodKeys() { return [...new Set(UNIFIED.map((r) => r.period_key))].sort(); }
function prevPeriod(key) { const k = periodKeys(); const i = k.indexOf(key); return i > 0 ? k[i - 1] : null; }

function currentFilters() {
  return {
    period: document.querySelector("#periodSelect").value,
    tier: document.querySelector("#tierSelect").value,
    seg: document.querySelector("#segSelect").value
  };
}
function applySeg(rows, f) {
  let out = rows;
  if (f.tier !== "all") out = out.filter((r) => r.tier === f.tier);
  if (f.seg === "room_comp") out = out.filter((r) => isTrue(r.is_room_only_comp));
  else if (f.seg === "own") out = out.filter((r) => isTrue(r.is_own_property));
  return out;
}
function periodRows(key, f) { return applySeg(UNIFIED.filter((r) => r.period_key === key), f); }

function areaAvgPrice(rows) {
  const ps = rows.map((r) => num(r.median_directional_price)).filter((n) => n != null && n > 0);
  return ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null;
}
function soldOutRate(rows) {
  let avail = 0, sold = 0;
  rows.forEach((r) => { if (r.unified_availability_status === "available") avail++; else if (r.unified_availability_status === "sold_out") sold++; });
  const d = avail + sold; return d === 0 ? null : sold / d;
}

/** Aggregate a period's unified rows to one entry per property. */
function byProperty(rows) {
  const m = new Map();
  rows.forEach((r) => {
    const k = r.canonical_property_name;
    const e = m.get(k) || { name: k, tier: r.tier, prices: [], statuses: [], srcMax: 0, latest: "", priceConf: "low", invConf: "low", comp: isTrue(r.is_room_only_comp), own: isTrue(r.is_own_property) };
    const p = num(r.median_directional_price); if (p != null && p > 0) e.prices.push(p);
    e.statuses.push(r.unified_availability_status);
    e.srcMax = Math.max(e.srcMax, num(r.source_count) || 0);
    if (r.latest_collected_at_jst > e.latest) e.latest = r.latest_collected_at_jst;
    // strongest confidence seen across the period
    if (rankConf(r.price_confidence) > rankConf(e.priceConf)) e.priceConf = r.price_confidence;
    if (rankConf(r.inventory_confidence) > rankConf(e.invConf)) e.invConf = r.inventory_confidence;
    m.set(k, e);
  });
  return [...m.values()].map((e) => ({
    ...e,
    medianPrice: e.prices.length ? Math.round([...e.prices].sort((a, b) => a - b)[Math.floor(e.prices.length / 2)]) : null,
    status: e.statuses.includes("available") ? "available" : e.statuses.includes("sold_out") ? "sold_out" : e.statuses.includes("not_found") ? "not_found" : "excluded"
  }));
}
function rankConf(c) { return c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0; }

function dailyAgg(rows) {
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
    checkin: e.checkin,
    avg: e.prices.length ? Math.round(e.prices.reduce((a, b) => a + b, 0) / e.prices.length) : null,
    avail: e.avail, sold: e.sold, nodata: e.nodata,
    rate: (e.avail + e.sold) === 0 ? 0 : e.sold / (e.avail + e.sold)
  }));
}

function render() {
  if (!UNIFIED.length) return;
  const f = currentFilters();
  const rows = periodRows(f.period, f);
  const prevKey = prevPeriod(f.period);
  const prevRows = prevKey ? periodRows(prevKey, f) : [];

  const avg = areaAvgPrice(rows), prevAvg = areaAvgPrice(prevRows);
  setText("#avgPrice", yen(avg));
  const avgEl = document.querySelector("#avgDelta");
  if (avg != null && prevAvg != null && prevAvg > 0) {
    const d = (avg - prevAvg) / prevAvg;
    avgEl.textContent = (d >= 0 ? "▲ " : "▼ ") + pct(Math.abs(d)) + "（前期間比）";
    avgEl.className = "delta " + (d > 0 ? "up" : d < 0 ? "down" : "flat");
  } else { avgEl.textContent = "前期間データ不足"; avgEl.className = "delta flat"; }

  const sr = soldOutRate(rows), prevSr = soldOutRate(prevRows);
  setText("#soldRate", pct(sr));
  const srEl = document.querySelector("#soldDelta");
  if (sr != null && prevSr != null) {
    const d = sr - prevSr;
    srEl.textContent = (d >= 0 ? "▲ " : "▼ ") + pct(Math.abs(d)) + "pt（前期間比）";
    srEl.className = "delta " + (d > 0 ? "up" : d < 0 ? "down" : "flat");
  } else { srEl.textContent = "前期間データ不足"; srEl.className = "delta flat"; }

  const props = byProperty(rows);
  const prevProps = new Map(byProperty(prevRows).map((p) => [p.name, p]));
  setText("#trackedProps", String(props.length));
  let rising = 0;
  props.forEach((p) => { const pp = prevProps.get(p.name); if (p.medianPrice != null && pp && pp.medianPrice != null && p.medianPrice > pp.medianPrice) rising++; });
  setText("#risingProps", String(rising));

  // Competitor inventory pressure for the period.
  const compRows = UNIFIED.filter((r) => r.period_key === f.period && isTrue(r.is_room_only_comp));
  const compByName = byProperty(compRows);
  let compSold = 0, compObserved = 0;
  ROOM_ONLY_COMPS.forEach((name) => {
    const e = compByName.find((x) => x.name === name);
    if (!e) return;
    if (e.status === "available") compObserved++;
    else if (e.status === "sold_out") { compObserved++; compSold++; }
  });
  setText("#compPressure", compObserved ? pct(compSold / compObserved) : "—");
  setText("#compCoverage", `coverage ${compObserved}/${ROOM_ONLY_COMPS.length}`);

  setText("#lastShort", META ? (META.latest_collected_at_jst || "—").slice(5, 16).replace("T", " ") : "—");

  // charts
  const daily = dailyAgg(rows);
  renderLine("#priceChart", daily.map((d) => ({ x: d.checkin, y: d.avg })));
  renderInventory("#inventoryChart", daily);
  renderHeat(daily);
  renderTable(props, prevProps);
  renderCompetitors(compByName);
  renderSignal({ sr, prevSr, avg, prevAvg, compSold, compObserved });
}

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function renderLine(sel, data) {
  const svg = document.querySelector(sel); svg.innerHTML = "";
  const pts = data.filter((d) => d.y != null);
  const w = svg.clientWidth || 360, h = svg.clientHeight || 210, pad = 30;
  if (pts.length === 0) { svg.appendChild(svgEl("text", { x: w / 2, y: h / 2, "text-anchor": "middle", fill: "#98a2b3" })).textContent = "価格データなし"; return; }
  const ys = pts.map((d) => d.y); const min = Math.min(...ys), max = Math.max(...ys);
  const X = (i) => pad + (i * (w - pad * 2)) / Math.max(1, pts.length - 1);
  const Y = (v) => h - pad - ((v - min) / Math.max(1, max - min)) * (h - pad * 2);
  let poly = "";
  pts.forEach((d, i) => { poly += `${X(i)},${Y(d.y)} `; });
  svg.appendChild(svgEl("polyline", { points: poly.trim(), fill: "none", stroke: "var(--blue)", "stroke-width": 2.5, "stroke-linejoin": "round" }));
  pts.forEach((d, i) => svg.appendChild(svgEl("circle", { cx: X(i), cy: Y(d.y), r: 3, fill: "var(--blue)" })));
}
function renderInventory(sel, daily) {
  const svg = document.querySelector(sel); svg.innerHTML = "";
  const w = svg.clientWidth || 360, h = svg.clientHeight || 210, pad = 24;
  if (!daily.length) return;
  const bw = (w - pad * 2) / daily.length;
  daily.forEach((d, i) => {
    const tot = d.avail + d.sold + d.nodata || 1;
    const x = pad + i * bw; let y = h - pad;
    const seg = [["#16a34a", d.avail], ["#ef4444", d.sold], ["#98a2b3", d.nodata]];
    seg.forEach(([color, v]) => {
      const sh = (v / tot) * (h - pad * 2);
      y -= sh;
      svg.appendChild(svgEl("rect", { x: x + 1, y, width: Math.max(1, bw - 2), height: sh, fill: color }));
    });
  });
}
function colorFor(v) { const hue = 120 - Math.min(1, v) * 120; return `hsl(${hue} 80% 88%)`; }
function renderHeat(daily) {
  const wrap = document.querySelector("#heatmap"); wrap.innerHTML = "";
  const head = document.createElement("div"); head.className = "head rowlab"; head.textContent = "在庫圧"; wrap.appendChild(head);
  const show = daily.slice(0, 7);
  while (show.length < 7) show.push(null);
  show.forEach((d) => { const c = document.createElement("div"); c.className = "head"; c.textContent = d ? d.checkin.slice(5) : "—"; wrap.appendChild(c); });
  const lab = document.createElement("div"); lab.className = "rowlab"; lab.textContent = "売り切れ率"; wrap.appendChild(lab);
  show.forEach((d) => { const c = document.createElement("div"); if (d) { c.style.background = colorFor(d.rate); c.textContent = (d.rate * 100).toFixed(0) + "%"; } else c.textContent = "—"; wrap.appendChild(c); });
}
function spark(vals) {
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return "<span style='color:#98a2b3'>—</span>";
  const w = 110, h = 28, min = Math.min(...v), max = Math.max(...v);
  const pts = v.map((y, i) => `${(i * w) / (v.length - 1)},${h - ((y - min) / Math.max(1, max - min)) * (h - 6) - 3}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function confBadge(c) { return `<span class="conf ${c}">${c}</span>`; }
function renderTable(props, prevProps) {
  const body = document.querySelector("#facilityBody"); body.innerHTML = "";
  props.sort((a, b) => (b.medianPrice || 0) - (a.medianPrice || 0)).forEach((p) => {
    const pp = prevProps.get(p.name);
    let delta = "—", cls = "flat";
    if (p.medianPrice != null && pp && pp.medianPrice != null && pp.medianPrice > 0) {
      const d = (p.medianPrice - pp.medianPrice) / pp.medianPrice;
      delta = (d >= 0 ? "▲ " : "▼ ") + (Math.abs(d) * 100).toFixed(1) + "%"; cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
    }
    const sparkVals = UNIFIED.filter((r) => r.canonical_property_name === p.name).sort((a, b) => a.checkin.localeCompare(b.checkin)).map((r) => num(r.median_directional_price));
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><b>${p.name}</b>${p.own ? " 🏠" : p.comp ? " ⭐" : ""}<div class="smallnote">${p.tier}</div></td>
      <td><span class="status ${p.status}">${p.status}</span></td>
      <td><b>${yen(p.medianPrice)}</b></td>
      <td class="${cls}" style="font-weight:800">${delta}</td>
      <td>${p.srcMax}</td>
      <td>${confBadge(p.priceConf)}</td>
      <td>${confBadge(p.invConf)}</td>
      <td class="smallnote">${(p.latest || "").slice(5, 16).replace("T", " ")}</td>
      <td>${spark(sparkVals)}</td>`;
    body.appendChild(tr);
  });
}
function renderCompetitors(compByName) {
  const wrap = document.querySelector("#competitorPanel"); wrap.innerHTML = "";
  ROOM_ONLY_COMPS.forEach((name) => {
    const e = compByName.find((x) => x.name === name);
    const status = e ? e.status : "no_data";
    const div = document.createElement("div"); div.className = "compitem";
    div.innerHTML = `<div><b>${COMP_LABEL[name]}</b><div class="smallnote">${e ? yen(e.medianPrice) + " / src " + e.srcMax : "観測なし"}</div></div>
      <div class="rate"><span class="status ${status === "no_data" ? "excluded" : status}">${status === "no_data" ? "—" : status}</span></div>`;
    wrap.appendChild(div);
  });
}
function renderSignal(s) {
  const el = document.querySelector("#signalText");
  let level = "weak", conf = s.compObserved >= 3 ? "high" : s.compObserved >= 2 ? "medium" : "low";
  if ((s.sr != null && s.sr >= 0.4) || s.compSold >= 2) level = "strong";
  else if ((s.sr != null && s.sr >= 0.2 && s.sr < 0.4) || s.compSold === 1) level = "medium";
  const kiraku = level === "strong" ? "hold_or_raise（在庫タイト）" : level === "medium" ? "hold（様子見）" : conf === "low" ? "monitor_or_hold（弱いが低カバレッジ・値下げ断定回避）" : "competitive_or_discount（軟調）";
  const miuraya = level === "strong" ? "raise_or_hold（こぼれ需要取り込み）" : level === "medium" ? "hold（据え置き）" : conf === "low" ? "monitor_or_hold（低カバレッジ・過度な値下げ回避）" : "discount_to_fill（充填優先）";
  el.textContent = `在庫KPI → 価格KPIの順で判断。エリア売切率 ${pct(s.sr)}、重点競合 sold_out ${s.compSold}/${s.compObserved}（confidence ${conf}）→ 在庫圧 ${level}。喜らく: ${kiraku} / 三浦屋: ${miuraya}`;
}

function init(text) {
  UNIFIED = parseCSV(text);
  const keys = periodKeys();
  const sel = document.querySelector("#periodSelect"); sel.innerHTML = "";
  keys.forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = periodLabel(k); sel.appendChild(o); });
  // default to the current/next period if present, else last
  sel.value = keys[0] || "";
  setText("#lastUpdated", META ? (META.latest_collected_at_jst || "—") : "—");
  if (META) document.querySelector("#footer").textContent = META.data_policy + ` ｜ sources: ${(META.sources_included || []).join(" + ")} ｜ unified_rows: ${META.unified_rows}`;
  render();
}

["#periodSelect", "#tierSelect", "#segSelect"].forEach((id) => document.querySelector(id).addEventListener("change", render));
document.querySelector("#fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => init(String(reader.result));
  reader.readAsText(file);
});

// Auto-load the exported unified dataset + metadata.
Promise.all([
  fetch("data/metadata.json").then((r) => r.ok ? r.json() : null).catch(() => null),
  fetch("data/zmi_market_unified.csv").then((r) => r.ok ? r.text() : "").catch(() => "")
]).then(([meta, csv]) => {
  META = meta;
  if (csv) init(csv);
  else setText("#lastUpdated", "CSV未読込（data/zmi_market_unified.csv をエクスポートしてください）");
});
