import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadSourceCapabilities,
  assertNoPaidSourcesEnabled
} from "../services/sourceCapabilityRegistry";

const FORBIDDEN_COLLECTOR_NAMES = [
  "serpapi",
  "dataforseo",
  "apify",
  "brightdata",
  "oxylabs"
];

// 1. Assert no paid sources are enabled in the capability registry
const capabilities = loadSourceCapabilities();
assertNoPaidSourcesEnabled(capabilities);
console.log("no_paid_sources_enabled=true");

// 2. Scan package.json collect: scripts for forbidden collector names.
//    Only "collect:" scripts are checked — config notes and test files
//    are expected to mention these names and should not trigger violations.
interface PkgJson {
  scripts: Record<string, string>;
}
const pkg = JSON.parse(
  readFileSync(resolve("package.json"), "utf8")
) as PkgJson;
const scripts = pkg.scripts ?? {};

const COLLECT_PREFIX = /^collect:/;
const violations: string[] = [];

for (const [scriptName, scriptValue] of Object.entries(scripts)) {
  if (!COLLECT_PREFIX.test(scriptName)) continue;
  for (const name of FORBIDDEN_COLLECTOR_NAMES) {
    if (scriptValue.toLowerCase().includes(name)) {
      violations.push(
        `collect script '${scriptName}' references forbidden name '${name}'`
      );
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`VIOLATION: ${v}`);
  }
  process.exit(1);
}

console.log("package_json_collect_scripts_clean=true");
console.log("check:no-paid-sources=passed");
