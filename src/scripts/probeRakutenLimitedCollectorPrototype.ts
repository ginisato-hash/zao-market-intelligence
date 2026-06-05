import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildCorrectedHplanCalendarUrl,
  parseHplanCalendarResponse,
  sanitizeHplanUrl,
  type HplanCalendarParsed
} from "../services/rakutenCorrectedHplanUrlProbe";
import {
  buildRakutenLimitedCollectorPrototypeSummary,
  buildRakutenPrototypeRequestSummary,
  decideRakutenLimitedCollectorPrototype,
  mapHplanDayToPrototypeRow,
  renderRakutenLimitedCollectorPrototypeCsv,
  renderRakutenLimitedCollectorPrototypeReport,
  type RakutenPrototypeDayRow,
  type RakutenPrototypeRequestSummary,
  type RakutenPrototypeRequestTarget
} from "../services/rakutenLimitedCollectorPrototype";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-limited-collector-prototype";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-limited-collector-prototype/0.1; low-volume read-only)";

const TARGETS = [
  {
    propertyName: "蔵王国際ホテル",
    hotelNo: "5723",
    fSyu: "00",
    fCampId: "6468227",
    monthAnchor: "20260601"
  },
  {
    propertyName: "蔵王国際ホテル",
    hotelNo: "5723",
    fSyu: "00",
    fCampId: "6468227",
    monthAnchor: "20260701"
  },
  {
    propertyName: "名湯リゾート ルーセント",
    hotelNo: "39565",
    fSyu: "honkan-exk",
    fCampId: "5623966",
    monthAnchor: "20260601"
  },
  {
    propertyName: "名湯リゾート ルーセント",
    hotelNo: "39565",
    fSyu: "honkan-exk",
    fCampId: "5623966",
    monthAnchor: "20260701"
  }
] satisfies RakutenPrototypeRequestTarget[];

interface EndpointFetch {
  status: number;
  body: string;
  error: string;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function collectedAtJst(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${parts.replace(" ", "T")}+09:00`;
}

function checkinFromCompact(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

async function fetchDirect(url: string): Promise<EndpointFetch> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    return { status: response.status, body: await response.text(), error: "" };
  } catch (error) {
    return {
      status: 0,
      body: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseOrNull(body: string, status: number): HplanCalendarParsed | null {
  const parsed = parseHplanCalendarResponse(body, status);
  if (!parsed.ok && parsed.days.length === 0 && status < 400) return null;
  return parsed;
}

function redactedParsed(parsed: HplanCalendarParsed | null): unknown {
  if (parsed === null) return null;
  return {
    ...parsed,
    days: parsed.days.map((day) => ({
      ...day,
      link: day.link.trim() === "" ? "" : "[redacted]",
      link_present: day.link.trim() !== ""
    }))
  };
}

async function runRakutenLimitedCollectorPrototype(): Promise<{
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
  requestSummaries: RakutenPrototypeRequestSummary[];
  dayRows: RakutenPrototypeDayRow[];
  decision: string;
  requestCount: number;
}> {
  const ts = timestamp();
  const runId = `rakuten_limited_${ts}`;
  const collectedAt = collectedAtJst();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const requestSummaries: RakutenPrototypeRequestSummary[] = [];
  const dayRows: RakutenPrototypeDayRow[] = [];
  let requestCount = 0;

  for (const target of TARGETS) {
    if (requestCount >= 4) break;
    const artifactDir = join(debugRootPath, `${target.hotelNo}_${target.fSyu}_${target.monthAnchor}`);
    await mkdir(artifactDir, { recursive: true });

    const requestUrl = buildCorrectedHplanCalendarUrl({
      hotelNo: target.hotelNo,
      fSyu: target.fSyu,
      fCampId: target.fCampId,
      checkin: checkinFromCompact(target.monthAnchor),
      dateScopeMode: "live_blank",
      callback: `cb_${target.hotelNo}_${target.monthAnchor}`,
      cacheBust: 0
    });
    const sanitizedUrl = sanitizeHplanUrl(requestUrl);
    await writeFile(join(artifactDir, "corrected_request_url.txt"), sanitizedUrl, "utf8");
    await writeFile(
      join(artifactDir, "corrected_request_params.json"),
      JSON.stringify(Object.fromEntries(new URL(requestUrl).searchParams.entries()), null, 2),
      "utf8"
    );

    const fetched = await fetchDirect(requestUrl);
    requestCount += 1;
    const parsed = parseOrNull(fetched.body, fetched.status);
    const rowsForRequest =
      parsed?.ok === true
        ? parsed.days.map((day) =>
            mapHplanDayToPrototypeRow({
              runId,
              collectedAtJst: collectedAt,
              target,
              parsed,
              day,
              debugArtifactPath: artifactDir
            })
          )
        : [];
    dayRows.push(...rowsForRequest);

    const requestSummary = buildRakutenPrototypeRequestSummary({
      target,
      httpStatus: fetched.status,
      parsed,
      dayRows: rowsForRequest,
      debugArtifactPath: artifactDir
    });
    requestSummaries.push(requestSummary);

    await writeFile(join(artifactDir, "response_body.txt"), fetched.body.slice(0, 500_000), "utf8");
    await writeFile(join(artifactDir, "response_parsed.json"), JSON.stringify(redactedParsed(parsed), null, 2), "utf8");
    await writeFile(join(artifactDir, "day_rows.json"), JSON.stringify(rowsForRequest, null, 2), "utf8");
    await writeFile(
      join(artifactDir, "request_summary.json"),
      JSON.stringify({ ...requestSummary, fetch_error: fetched.error, request_url_sanitized: sanitizedUrl }, null, 2),
      "utf8"
    );
  }

  const decision = decideRakutenLimitedCollectorPrototype({ requestSummaries, dayRows });
  const summary = buildRakutenLimitedCollectorPrototypeSummary({
    runId,
    collectedAtJst: collectedAt,
    requestSummaries,
    dayRows,
    decision
  });

  const csvPath = resolve(REPORT_DIR, `rakuten_limited_collector_prototype_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_limited_collector_prototype_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `rakuten_limited_collector_prototype_${ts}.json`);
  writeFileSync(csvPath, renderRakutenLimitedCollectorPrototypeCsv(dayRows), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, requestSummaries }, null, 2), "utf8");
  writeFileSync(
    reportPath,
    renderRakutenLimitedCollectorPrototypeReport({
      generatedAt: new Date().toISOString(),
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath,
      targets: TARGETS,
      requestSummaries,
      dayRows,
      summary
    }),
    "utf8"
  );
  await writeFile(join(debugRootPath, "summary.json"), JSON.stringify({ summary, requestSummaries }, null, 2), "utf8");

  return { reportPath, csvPath, jsonPath, debugRootPath, requestSummaries, dayRows, decision, requestCount };
}

runRakutenLimitedCollectorPrototype()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`json_summary_path=${result.jsonPath}`);
    console.log(`debug_root=${result.debugRootPath}`);
    console.log(`request_count=${result.requestCount}`);
    console.log(`request_classification_counts=${JSON.stringify(countBy(result.requestSummaries.map((r) => r.classification)))}`);
    console.log(`day_classification_counts=${JSON.stringify(countBy(result.dayRows.map((r) => r.classification)))}`);
    console.log(`decision=${result.decision}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
