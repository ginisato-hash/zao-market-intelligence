// Winter far-lead ACTIVE refresh capacity simulation (READ-ONLY; no network, browser, DB or history write).
//
// Replays the REAL planner (buildRotatingPlan) for 14 days x 12 slots from the committed .data/history with Q1
// (2027-01-01..03-31) SELLABLE and 12/20-12/31 not. Every selected page advances the planner's last-collected map
// (a failed Booking run does not). Whether a fetch of a modelled property yields a PRICEABLE comparable-segment
// quote (confirmed 2-person standard room, 2 adults, room only, available, plausible price) is a seeded Bernoulli
// draw; non-priceable outcomes are modelled as producing no comparable-segment row. Only the FIRST fetch of a
// (source, property, night) per JST day counts (collection-day identity).
//
// Clock: every instant is a true epoch (Date.parse with +09:00); the planner gets JST wall-clock "+09:00" strings and
// the scope manifest a UTC "Z" generated_at. RMS ingests at 05:30 JST (sees fetches up to 05:30, i.e. through the 04:00
// run) and decides at 06:00 JST. Freshness SLO by lead: <=21d 24h, 22-60d 48h, >60d 72h.
//
// Metrics at each 06:00 decision, over future Q1 nights:
//   proxy3  >=3 distinct modelled peers with a fresh priceable quote. A 3-QUOTE AVAILABILITY PROXY / UPPER BOUND of
//           the RMS after-sale gate, conditional on transition timing and aggregate consistency (not modelled here).
//   medianSetProxy  proxy3 AND every modelled peer whose latest priceable quote is visible is itself fresh (a stale
//           quote left in the median set holds the night). A FRESH MEDIAN-SET PROXY conditional on a synthetic consistent
//           aggregate and an assumed transition time; NOT an RMS production release rate.
//   own     Kiraku's own latest priceable quote (any lane, any source) is fresh.
//   own&X   both at once.
// Success probabilities carry their own uncertainty: Jeffreys Beta(s+1/2, n-s+1/2) per (property, source); --param
// point|posterior|p05 uses the posterior mean, a fresh draw per trial, or the 5th percentile.
//
//   node --import tsx src/scripts/simulateWinterActiveRefresh.ts [--trials 25] [--cfg <index>] [--model-file model.json (default: SYNTHETIC fixture)]
//     [--param point|posterior|p05] [--peers lane|v1_all] [--seed-segments file.json] [--dump file.jsonl --dump-trials n]
//     [--base-planner /path/to/base/rotatingCollectionScopePlanner.ts]
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { liveTargets } from "../services/marketRefreshTargetUniverse";
import {
  buildRotatingPlan, scaledRotatingCaps, DEFAULT_SERVICE_DEADLINE_HOURS, OWN_PROPERTY_CRITICAL_LEAD_DAYS, RMS_CRITICAL_LEAD_DAYS,
  SLOT_HOURS, WINTER_COMPARABLE_SETS, type RotatingDemandConfig, type RotatingPlan
} from "../services/rotatingCollectionScopePlanner";
import { MARKET_RESEARCH_SKI_SEASON_WINDOW, kirakuWinterSalesDates } from "../services/kirakuWinterSalesWindow";
import { parseWinterSalesScope, type WinterSalesScope } from "../services/kirakuWinterSalesScope";
import { getOwnPropertyKey } from "../services/ownPropertyTargets";
import { parseCsv } from "../services/localHistoryAppendValidationPolicy";
import type { WinterComparableSetId } from "../services/crawlVolumeConfig";

// ---------------------------------------------------------------- clock (exported for tests)
export const HOUR_MS = 3_600_000;
const JST_OFFSET_MS = 9 * HOUR_MS;
const pad2 = (n: number): string => String(n).padStart(2, "0");
/** True epoch of a JST wall-clock slot. */
export function jstSlotMs(ymd: string, hour: number, minute = 0): number { return Date.parse(`${ymd}T${pad2(hour)}:${pad2(minute)}:00+09:00`); }
/** JST wall-clock ISO with explicit +09:00 (planner / history convention). */
export function jstIso(ms: number): string { return `${new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`; }
export function jstYmd(ms: number): string { return jstIso(ms).slice(0, 10); }
export function addDaysYmd(ymd: string, n: number): string { return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); }
export function leadDays(fromYmd: string, toYmd: string): number { return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000); }
export const RMS_INGEST_JST = { hour: 5, minute: 30 } as const;
export const RMS_DECISION_HOUR_JST = 6;
/** The 06:00 JST decision reads what the 05:30 JST ingest saw that same JST day. */
export function ingestCutoffMs(decisionMs: number): number { return jstSlotMs(jstYmd(decisionMs), RMS_INGEST_JST.hour, RMS_INGEST_JST.minute); }
/** RMS after-sale freshness SLO (hours) by lead. */
export function freshnessSloHours(lead: number): number { return lead <= 21 ? 24 : lead <= 60 ? 48 : 72; }
/** Fresh at the decision: acquired no later than the ingest cutoff and within the SLO of the decision instant. */
export function isFreshAt(obsMs: number | undefined, decisionMs: number, lead: number): boolean {
  return obsMs !== undefined && obsMs <= ingestCutoffMs(decisionMs) && decisionMs - obsMs <= freshnessSloHours(lead) * HOUR_MS;
}

// ---------------------------------------------------------------- history (exported for tests)
const JST_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+09:00$/u;
const YMD = /^\d{4}-\d{2}-\d{2}$/u;
const REQUIRED_COLUMNS = ["source", "source_slug_or_code", "checkin", "collected_at_jst"] as const;
export interface HistoryLoad { map: Map<string, string>; accepted: number; skipped: number; rejected: Record<string, number> }
/** Last collected_at per (source|slug|checkin) from quoted CSV text; malformed rows are rejected, never repaired. */
export function lastCollectedFromCsv(texts: Iterable<string>, cutoffMs: number): HistoryLoad {
  const out: HistoryLoad = { map: new Map(), accepted: 0, skipped: 0, rejected: {} };
  const reject = (why: string): void => { out.rejected[why] = (out.rejected[why] ?? 0) + 1; };
  for (const text of texts) {
    const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
    const head = rows[0];
    if (head === undefined) continue;
    const ix = REQUIRED_COLUMNS.map((c) => head.indexOf(c));
    if (ix.some((i) => i < 0)) { reject("file_missing_required_column"); continue; }
    const [iSrc, iSlug, iIn, iAt] = ix as [number, number, number, number];
    for (const r of rows.slice(1)) {
      if (r.length !== head.length) { reject("column_count_mismatch"); continue; }
      const src = r[iSrc]!, slug = r[iSlug]!, checkin = r[iIn]!, at = r[iAt]!;
      if (src !== "booking" && src !== "jalan") { out.skipped++; continue; }
      if (slug === "") { reject("empty_slug"); continue; }
      if (!YMD.test(checkin)) { reject("checkin_not_ymd"); continue; }
      if (!JST_TS.test(at) || !Number.isFinite(Date.parse(at))) { reject("collected_at_not_jst_offset_iso"); continue; }
      if (Date.parse(at) > cutoffMs) { out.skipped++; continue; }
      const k = `${src}|${slug}|${checkin}`; const prev = out.map.get(k);
      if (prev === undefined || Date.parse(at) > Date.parse(prev)) out.map.set(k, at);
      out.accepted++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- success model (exported for tests)
/** s successes of n observed fetches, or a fixed probability p (legacy). */
export type RateSpec = { s: number; n: number } | { p: number };
export interface PropertyRates { booking?: RateSpec; jalan?: RateSpec }
// RMS v1 PRIMARY_COMPARABLE property names (peer_membership_v1_2026-09-02) as ZMI canonical names.
export const V1_PRIMARY_NAMES = ["ル・ベール蔵王", "名湯舎 創", "ONSEN & STAY OAKHILL", "HAMMOND", "ペンション木いちご", "松尾ハウス",
  "蔵王温泉 高砂屋旅館", "ロッジスガノ", "ペンションぷうたろう", "吉田屋"] as const;
export const OWN_KEY = "__own__";
// SYNTHETIC fixture (not measured): lets the simulator self-test without any private data. Real per-property
// success counts are private model inputs passed with --model-file (JSON of the same shape); they are not tracked here.
export const SYNTHETIC_MODEL: Readonly<Record<string, PropertyRates>> = Object.freeze({
  ...Object.fromEntries(V1_PRIMARY_NAMES.map((n) => [n, { booking: { s: 80, n: 100 }, jalan: { s: 20, n: 100 } }])),
  [OWN_KEY]: { booking: { s: 75, n: 100 }, jalan: { s: 40, n: 100 } }
});
/** Validates a --model-file payload; malformed input is rejected (fail closed), never defaulted. */
export function parseModel(raw: unknown): Record<string, PropertyRates> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("model: not an object");
  const okSpec = (x: unknown): x is RateSpec => x !== null && typeof x === "object" && (
    ("p" in x && typeof (x as { p: unknown }).p === "number" && (x as { p: number }).p >= 0 && (x as { p: number }).p <= 1)
    || ("s" in x && "n" in x && Number.isInteger((x as { s: unknown }).s) && Number.isInteger((x as { n: unknown }).n)
      && (x as { s: number }).s >= 0 && (x as { s: number }).s <= (x as { n: number }).n));
  const out: Record<string, PropertyRates> = {};
  for (const [name, r] of Object.entries(raw as Record<string, unknown>)) {
    if (r === null || typeof r !== "object") throw new Error(`model: ${name} not an object`);
    const pr: PropertyRates = {};
    for (const [src, spec] of Object.entries(r as Record<string, unknown>)) {
      if (src !== "booking" && src !== "jalan") throw new Error(`model: ${name} unknown source ${src}`);
      if (!okSpec(spec)) throw new Error(`model: ${name}.${src} malformed`);
      pr[src] = spec;
    }
    out[name] = pr;
  }
  return out;
}

export function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(rnd: () => number): number { return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd()); }
function gamma(k: number, rnd: () => number): number {  // Marsaglia-Tsang
  if (k < 1) return gamma(k + 1, rnd) * Math.pow(rnd(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x: number, v: number; do { x = gauss(rnd); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = rnd();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
export function betaDraw(a: number, b: number, rnd: () => number): number { const x = gamma(a, rnd); return x / (x + gamma(b, rnd)); }
/** Jeffreys posterior summary: mean and 90% interval (5th/95th percentiles, deterministic sampling). */
export function posterior(spec: RateSpec): { mean: number; p05: number; p95: number } {
  if ("p" in spec) return { mean: spec.p, p05: spec.p, p95: spec.p };
  const a = spec.s + 0.5, b = spec.n - spec.s + 0.5; const rnd = mulberry32(7); const xs: number[] = [];
  for (let i = 0; i < 20_000; i++) xs.push(betaDraw(a, b, rnd));
  xs.sort((x, y) => x - y);
  return { mean: a / (a + b), p05: xs[Math.floor(0.05 * xs.length)]!, p95: xs[Math.floor(0.95 * xs.length)]! };
}
export type ParamMode = "point" | "posterior" | "p05";
function drawRates(model: Record<string, PropertyRates>, mode: ParamMode, rnd: () => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, rates] of Object.entries(model)) for (const src of ["booking", "jalan"] as const) {
    const spec = rates[src]; if (spec === undefined) continue;
    out.set(`${name}|${src}`, "p" in spec ? spec.p : mode === "posterior" ? betaDraw(spec.s + 0.5, spec.n - spec.s + 0.5, rnd)
      : mode === "p05" ? posterior(spec).p05 : posterior(spec).mean);
  }
  return out;
}

// ---------------------------------------------------------------- night evaluation (exported for tests)
export interface NightVerdict { proxy3: boolean; medianSetProxy: boolean; own: boolean; freshPeers: number; staleVisible: number }
/** One Q1 night at one 06:00 decision. peerObs: latest priceable obs per modelled peer (ms); ownObs: own latest. */
export function evaluateNight(decisionMs: number, lead: number, peerObs: ReadonlyArray<number | undefined>, ownObs: number | undefined): NightVerdict {
  const cutoff = ingestCutoffMs(decisionMs);
  const visible = peerObs.filter((t): t is number => t !== undefined && t <= cutoff);
  const fresh = visible.filter((t) => isFreshAt(t, decisionMs, lead)).length;
  const proxy3 = fresh >= 3;
  return { proxy3, medianSetProxy: proxy3 && fresh === visible.length, own: isFreshAt(ownObs, decisionMs, lead), freshPeers: fresh, staleVisible: visible.length - fresh };
}

// ---------------------------------------------------------------- simulation
type PlanFn = (input: Parameters<typeof buildRotatingPlan>[0]) => RotatingPlan;
const START = "2026-10-15"; const DAYS = 14; const WARMUP = 7;
const CONFIG: RotatingDemandConfig = { public_holidays: {}, long_weekend_dates: new Set(),
  peak_periods: [{ code: "ski_season", from: MARKET_RESEARCH_SKI_SEASON_WINDOW.from, to: MARKET_RESEARCH_SKI_SEASON_WINDOW.to, saturday_only: true }] };
const Q1 = kirakuWinterSalesDates().filter((d) => d >= "2027-01-01");

function scopeAt(nowMs: number): WinterSalesScope {
  return parseWinterSalesScope({ schema_version: "kiraku_winter_sales_scope_v1", property_id: "330695", generated_at: new Date(nowMs).toISOString(),
    season: { from: "2026-12-20", to: "2027-03-31" },
    dates: kirakuWinterSalesDates().map((d) => ({ stay_date: d, state: d >= "2027-01-01" ? "SELLABLE" : "NO_SELLABLE_INVENTORY",
      sellable_room_count: d >= "2027-01-01" ? 1 : 0, newly_sellable: false, transition_detected_at: null })) }, nowMs);
}

interface Cfg { name: string; activeRefresh: boolean; set: WinterComparableSetId; multiplier: number; bookingFail?: number }
interface Opts { model: Record<string, PropertyRates>; param: ParamMode; peers: "lane" | "v1_all"; seeds: Array<{ name: string; date: string; observedAt: string }>; dump?: string; dumpTrials: number }
interface TrialOut { proxy3: number; strict: number; own: number; ownProxy: number; ownStrict: number; winterPerRun: number; ownQuota: number;
  regularNearPerDay: number; starved84: number; over96: number; bpPct: number; maxPerProp: number }

function run(cfg: Cfg, plan: PlanFn, history: Map<string, string>, trial: number, opts: Opts, capture?: string[][]): TrialOut {
  const rnd = mulberry32(1000 + trial); const rates = drawRates(opts.model, opts.param, mulberry32(5000 + trial));
  const caps = scaledRotatingCaps(cfg.multiplier); const targets = liveTargets();
  const lanePeers = [...WINTER_COMPARABLE_SETS[cfg.set].slugs].map((s) => targets.find((t) => t.source === "booking" && t.property_slug === s)!.canonical_property_name);
  const peers: string[] = opts.peers === "v1_all" ? [...V1_PRIMARY_NAMES] : lanePeers;
  const last = new Map(history); const seg = new Map<string, number>(); const own = new Map<string, number>(); const firstOfDay = new Set<string>();
  for (const s of opts.seeds) if (peers.includes(s.name)) { const t = Date.parse(s.observedAt); if (Number.isFinite(t)) seg.set(`${s.name}|${s.date}`, t); }
  const bookingTargets = targets.filter((t) => t.source === "booking" && t.enabled_for_live && t.verified_mapping);
  const startMs = jstSlotMs(START, 0);
  const acc = { proxy3: [] as number[], strict: [] as number[], own: [] as number[], ownProxy: [] as number[], ownStrict: [] as number[], starved84: [] as number[], over96: [] as number[] };
  let winterSel = 0, ownQuota = 0, regularNear = 0, bp = 0, runs = 0, maxPerProp = 0;
  for (let day = 0; day < DAYS; day++) for (const hour of SLOT_HOURS) {
    const nowMs = startMs + day * 24 * HOUR_MS + hour * HOUR_MS; const nowIso = jstIso(nowMs); const runDate = jstYmd(nowMs);
    if (hour === RMS_DECISION_HOUR_JST && day >= WARMUP) {
      const c = { proxy3: 0, strict: 0, own: 0, ownProxy: 0, ownStrict: 0, n: 0 }; const dumpNights: unknown[] = [];
      const cutoff = ingestCutoffMs(nowMs);
      for (const d of Q1) {
        const lead = leadDays(runDate, d); if (lead < 1) continue;
        const v = evaluateNight(nowMs, lead, peers.map((p) => seg.get(`${p}|${d}`)), own.get(d));
        c.n++; c.proxy3 += +v.proxy3; c.strict += +v.medianSetProxy; c.own += +v.own; c.ownProxy += +(v.own && v.proxy3); c.ownStrict += +(v.own && v.medianSetProxy);
        if (opts.dump !== undefined && trial < opts.dumpTrials) dumpNights.push({ stayDate: d, leadDays: lead,
          quotes: peers.flatMap((p) => { const t = seg.get(`${p}|${d}`); return t !== undefined && t <= cutoff ? [{ propertyName: p, observedAt: new Date(t).toISOString() }] : []; }),
          ownObservedAt: own.has(d) && own.get(d)! <= cutoff ? new Date(own.get(d)!).toISOString() : null, sim: v });
      }
      for (const k of ["proxy3", "strict", "own", "ownProxy", "ownStrict"] as const) acc[k].push(c[k] / c.n);
      if (opts.dump !== undefined && trial < opts.dumpTrials) appendFileSync(opts.dump, `${JSON.stringify({ cfg: cfg.name, trial, decision: new Date(nowMs).toISOString(), ingestCutoff: new Date(cutoff).toISOString(), nights: dumpNights })}\n`);
      // near-term (existing RMS-critical horizon, Booking): unserved or >=84h (starved) and >96h.
      let s84 = 0, o96 = 0;
      for (const t of bookingTargets) {
        const horizon = getOwnPropertyKey(t.canonical_property_name) === "kiraku" ? OWN_PROPERTY_CRITICAL_LEAD_DAYS : RMS_CRITICAL_LEAD_DAYS;
        for (let off = 1; off <= horizon; off++) {
          const at = last.get(`booking|${t.property_slug}|${addDaysYmd(runDate, off)}`); const age = at === undefined ? Infinity : (nowMs - Date.parse(at)) / HOUR_MS;
          if (age >= DEFAULT_SERVICE_DEADLINE_HOURS) s84++;
          if (age > 96) o96++;
        }
      }
      acc.starved84.push(s84); acc.over96.push(o96);
    }
    const p = plan({ runDateIso: runDate, nowIso, slotHourJst: hour, liveTargets: targets, config: CONFIG, lastCollectedAt: last, caps,
      winterLaneEnabled: true, winterScope: scopeAt(nowMs),
      ...(cfg.activeRefresh ? { winterActiveRefresh: true } : {}), ...(cfg.set !== "registry_v0" ? { winterComparableSet: cfg.set } : {}) });
    capture?.push(p.selected.map((t) => `${t.source}|${t.property_slug}|${t.stay_date}|${t.winter_lane ?? ""}`));
    runs++; const wl = p.winter_lane; if (wl.backpressure_active) bp++;
    ownQuota += wl.own_quota_per_run ?? 0;
    const perProp = new Map<string, number>();
    const bookingBlocked = cfg.bookingFail !== undefined && rnd() < cfg.bookingFail;
    for (const t of p.selected) {
      if (t.source === "booking") { perProp.set(t.property_slug, (perProp.get(t.property_slug) ?? 0) + 1); if (t.winter_lane !== undefined) winterSel++; else if (t.rms_critical) regularNear++; }
      if (t.source === "booking" && bookingBlocked) continue;                          // failed run: nothing appended
      last.set(`${t.source}|${t.property_slug}|${t.stay_date}`, nowIso);
      if (!Q1.includes(t.stay_date)) continue;
      const idKey = `${t.source}|${t.property_slug}|${t.stay_date}|${runDate}`;
      if (firstOfDay.has(idKey)) continue;                                             // collection-day identity
      firstOfDay.add(idKey);
      const isOwn = getOwnPropertyKey(t.canonical_property_name) === "kiraku";
      const name = isOwn ? OWN_KEY : t.canonical_property_name;
      if (!isOwn && !peers.includes(name)) continue;
      const pr = rates.get(`${name}|${t.source}`); if (pr === undefined) continue;     // no measured rate => no quote
      if (rnd() < pr) { if (isOwn) own.set(t.stay_date, nowMs); else seg.set(`${name}|${t.stay_date}`, nowMs); }
    }
    if (perProp.size > 0) maxPerProp = Math.max(maxPerProp, ...perProp.values());
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return { proxy3: mean(acc.proxy3), strict: mean(acc.strict), own: mean(acc.own), ownProxy: mean(acc.ownProxy), ownStrict: mean(acc.ownStrict),
    winterPerRun: winterSel / runs, ownQuota: ownQuota / runs, regularNearPerDay: regularNear / DAYS, starved84: mean(acc.starved84), over96: mean(acc.over96),
    bpPct: (100 * bp) / runs, maxPerProp };
}

export const CONFIGS: Cfg[] = [
  { name: "OFF (current) x4, registry", activeRefresh: false, set: "registry_v0", multiplier: 4 },
  { name: "ON x4, registry", activeRefresh: true, set: "registry_v0", multiplier: 4 },
  { name: "ON x4, primary_v1_best5", activeRefresh: true, set: "primary_v1_best5", multiplier: 4 },
  { name: "ON x5, primary_v1_best5 (hypothetical x5)", activeRefresh: true, set: "primary_v1_best5", multiplier: 5 },
  { name: "ON x4, best5, Booking run failure 20%", activeRefresh: true, set: "primary_v1_best5", multiplier: 4, bookingFail: 0.2 },
  { name: "OFF (current) x4, registry, Booking run failure 20%", activeRefresh: false, set: "registry_v0", multiplier: 4, bookingFail: 0.2 }
];

function loadHistory(): HistoryLoad {
  const dir = ".data/history";
  return lastCollectedFromCsv(readdirSync(dir).filter((x) => /^zao_signals_.*\.csv$/u.test(x)).sort().map((f) => readFileSync(join(dir, f), "utf8")), jstSlotMs(START, 0));
}

async function main(): Promise<void> {
  const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const trials = Number(arg("trials") ?? 25);
  const modelFile = arg("model-file");
  const model = modelFile !== undefined ? parseModel(JSON.parse(readFileSync(modelFile, "utf8"))) : SYNTHETIC_MODEL;
  const modelName = modelFile !== undefined ? `file:${modelFile.split("/").pop()}` : "SYNTHETIC_FIXTURE(not measured)";
  const param = (arg("param") ?? "posterior") as ParamMode; if (!["point", "posterior", "p05"].includes(param)) throw new Error(`unknown --param ${param}`);
  const peers = (arg("peers") ?? "lane") as Opts["peers"];
  const seedsPath = arg("seed-segments"); const dump = arg("dump");
  if (dump !== undefined) writeFileSync(dump, "");
  const opts: Opts = { model, param, peers, seeds: seedsPath !== undefined ? JSON.parse(readFileSync(seedsPath, "utf8")) as Opts["seeds"] : [], ...(dump !== undefined ? { dump } : {}), dumpTrials: Number(arg("dump-trials") ?? 1) };
  const h = loadHistory();
  console.log(`trials=${trials} model=${modelName} param=${param} peers=${peers} seeds=${opts.seeds.length} days=${DAYS} (scored last ${DAYS - WARMUP}) start=${START}T00:00+09:00 history: accepted=${h.accepted} skipped=${h.skipped} rejected=${JSON.stringify(h.rejected)} keys=${h.map.size}`);
  console.log("rates (Jeffreys mean [90% interval]):", Object.entries(model).map(([n, r]) => `${n === OWN_KEY ? "OWN" : n}: ${(["booking", "jalan"] as const).filter((s) => r[s] !== undefined).map((s) => { const sp = r[s]!; const q = posterior(sp); return `${s} ${"p" in sp ? `fixed ${sp.p.toFixed(3)}` : `${sp.s}/${sp.n} ${q.mean.toFixed(2)} [${q.p05.toFixed(2)},${q.p95.toFixed(2)}]`}`; }).join(", ")}`).join(" | "));
  console.log("config | proxy3 mean (min trial) | medianSetProxy (synthetic consistent aggregate + assumed transition; NOT RMS production readiness) | own | own&proxy3 | own&medianSetProxy (p5 trial) | winter cells/run | own quota/run | regular near-term Booking/day | near-term starved>=84h | >96h | backpressure % | max Booking/property/run");
  const only = arg("cfg");
  for (const [ci, cfg] of CONFIGS.entries()) {
    if (only !== undefined && String(ci) !== only) continue;
    const r = Array.from({ length: trials }, (_, i) => run(cfg, buildRotatingPlan, h.map, i, opts));
    const m = (f: (x: TrialOut) => number) => r.reduce((a, x) => a + f(x), 0) / r.length;
    const pct = (f: (x: TrialOut) => number) => `${(100 * m(f)).toFixed(1)}%`;
    const p5 = (f: (x: TrialOut) => number) => { const v = r.map(f).sort((a, b) => a - b); return (100 * v[Math.floor(0.05 * v.length)]!).toFixed(1); };
    console.log(`${cfg.name} | ${pct((x) => x.proxy3)} (${(100 * Math.min(...r.map((x) => x.proxy3))).toFixed(1)}) | ${pct((x) => x.strict)} | ${pct((x) => x.own)} | ${pct((x) => x.ownProxy)} | ${pct((x) => x.ownStrict)} (${p5((x) => x.ownStrict)}) | ${m((x) => x.winterPerRun).toFixed(1)} | ${m((x) => x.ownQuota).toFixed(1)} | ${m((x) => x.regularNearPerDay).toFixed(0)} | ${m((x) => x.starved84).toFixed(0)} | ${m((x) => x.over96).toFixed(0)} | ${m((x) => x.bpPct).toFixed(0)} | ${Math.max(...r.map((x) => x.maxPerProp))}`);
  }
  const base = arg("base-planner");
  if (base !== undefined && existsSync(base)) {
    const mod = (await import(pathToFileURL(base).href)) as { buildRotatingPlan: PlanFn };
    const a: string[][] = []; const b: string[][] = []; const off: Cfg = { name: "off", activeRefresh: false, set: "registry_v0", multiplier: 4 };
    run(off, mod.buildRotatingPlan, h.map, 0, opts, a); run(off, buildRotatingPlan, h.map, 0, opts, b);
    const same = a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));
    console.log(`flag-OFF equivalence vs base planner (${base}): ${a.length} slots, ${a.reduce((n, x) => n + x.length, 0)} selections -> ${same ? "IDENTICAL" : "DIFFERENT"}`);
    if (!same) process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && process.argv[1].endsWith("simulateWinterActiveRefresh.ts")) void main();
