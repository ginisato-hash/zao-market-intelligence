// Phase AUTO-RUNNER16X — daily collection coverage report (read-only).
//
// Reads canonical history CSVs and emits a coverage summary (md + csv): rows by
// source / property / stay-month / confidence, dp-directional usable counts,
// recently-collected target count, and simple bias warnings. No DB writes, no
// collection, no mutation.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";

function parseCsvLine(line: string): string[] {
  const cells: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur);
  return cells;
}

function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function bump(map: Record<string, number>, key: string): void { map[key] = (map[key] ?? 0) + 1; }

function run(): void {
  if (!existsSync(HISTORY_DIR)) { console.error("decision=collection_coverage_no_history"); process.exitCode = 1; return; }
  const today = todayJst();
  const bySource: Record<string, number> = {};
  const byProperty: Record<string, number> = {};
  const byStayMonth: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  let dpDirectional = 0; let excluded = 0; let total = 0; let collectedToday = 0;

  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const lines = readFileSync(join(HISTORY_DIR, f), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const h = parseCsvLine(lines[0]!);
    const si = h.indexOf("source"); const ni = h.indexOf("canonical_property_name"); const ci = h.indexOf("checkin");
    const bi = h.indexOf("basis_confidence"); const ddi = h.indexOf("is_price_usable_for_dp_directional"); const dei = h.indexOf("is_price_excluded_from_dp");
    const cdi = h.indexOf("collected_date_jst");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line); total += 1;
      bump(bySource, c[si] ?? "unknown");
      bump(byProperty, `${c[si]}:${c[ni]}`);
      bump(byStayMonth, (c[ci] ?? "").slice(0, 7));
      bump(byConfidence, c[bi] ?? "unknown");
      if ((c[ddi] ?? "").toLowerCase() === "true") dpDirectional += 1;
      if ((c[dei] ?? "").toLowerCase() === "true") excluded += 1;
      if ((c[cdi] ?? "") === today) collectedToday += 1;
    }
  }

  const warnings: string[] = [];
  const propEntries = Object.entries(byProperty).sort((a, b) => b[1] - a[1]);
  if (propEntries.length > 0 && propEntries[0]![1] > total * 0.25) warnings.push(`property_bias: ${propEntries[0]![0]} holds ${propEntries[0]![1]}/${total} rows`);
  const monthEntries = Object.entries(byStayMonth).sort((a, b) => b[1] - a[1]);
  if (monthEntries.length > 0 && monthEntries[0]![1] > total * 0.5) warnings.push(`date_bias: month ${monthEntries[0]![0]} holds ${monthEntries[0]![1]}/${total} rows`);

  const ts = `${today.replace(/-/g, "")}`;
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const mdPath = resolve(REPORT_DIR, `collection_coverage_${ts}.md`);
  const csvPath = resolve(REPORT_DIR, `collection_coverage_${ts}.csv`);

  const md = `# Collection Coverage — ${today}

- total_rows: ${total}
- by_source: ${JSON.stringify(bySource)}
- by_stay_month: ${JSON.stringify(byStayMonth)}
- by_confidence: ${JSON.stringify(byConfidence)}
- dp_directional_usable: ${dpDirectional}
- excluded: ${excluded}
- collected_today (${today}): ${collectedToday}
- distinct_properties: ${Object.keys(byProperty).length}

## Top properties
${propEntries.slice(0, 20).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

## Bias warnings
${warnings.length > 0 ? warnings.map((w) => `- ${w}`).join("\n") : "- none"}
`;
  writeFileSync(mdPath, md, "utf8");
  const header = ["dimension", "key", "rows"];
  const rows: string[] = [];
  for (const [k, v] of Object.entries(bySource)) rows.push(`source,${k},${v}`);
  for (const [k, v] of Object.entries(byStayMonth)) rows.push(`stay_month,${k},${v}`);
  for (const [k, v] of propEntries) rows.push(`property,"${k}",${v}`);
  writeFileSync(csvPath, [header.join(","), ...rows].join("\n") + "\n", "utf8");

  console.log(`decision=collection_coverage_ready`);
  console.log(`total_rows=${total}`);
  console.log(`by_source=${JSON.stringify(bySource)}`);
  console.log(`collected_today=${collectedToday}`);
  console.log(`warnings=${warnings.length}`);
  console.log(`md_path=${mdPath}`);
  console.log(`csv_path=${csvPath}`);
}

run();
