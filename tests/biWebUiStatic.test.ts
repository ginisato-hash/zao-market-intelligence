import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HTML = readFileSync(resolve(__dirname, "../apps/zmi-bi-web/index.html"), "utf8");
const JS = readFileSync(resolve(__dirname, "../apps/zmi-bi-web/assets/app.js"), "utf8");
const CSS = readFileSync(resolve(__dirname, "../apps/zmi-bi-web/assets/app.css"), "utf8");

describe("ZMI BI UI v3 - removed fake/unused controls", () => {
  it("no CSV upload input (fileInput)", () => {
    expect(HTML).not.toContain("fileInput");
    expect(JS).not.toContain("fileInput");
    expect(HTML).not.toContain("CSV読込");
  });
  it("no disabled source select (sourceFixed / sourceSelect)", () => {
    expect(HTML).not.toContain("sourceFixed");
    expect(HTML).not.toContain("sourceSelect");
    expect(JS).not.toContain("sourceSelect");
  });
  it("no empty anchors or href=# fake links", () => {
    expect(HTML).not.toMatch(/<a\b/);
    expect(HTML).not.toContain('href="#"');
  });
  it("no sidebar nav remnant", () => {
    expect(HTML).not.toContain('class="sidebar"');
    expect(HTML).not.toContain('class="nav"');
  });
});

describe("ZMI BI UI v3 - functional controls present", () => {
  it("has the four functional buttons", () => {
    for (const id of ["refreshBtn", "resetBtn", "exportVisibleBtn", "copyStateBtn"]) {
      expect(HTML, id).toContain(`id="${id}"`);
      expect(JS, id).toContain(id);
    }
  });
  it("buttons are type=button (no implicit submit / fake)", () => {
    const btnCount = (HTML.match(/<button\b/g) || []).length;
    const typedCount = (HTML.match(/<button type="button"/g) || []).length;
    expect(typedCount).toBe(btnCount);
  });
  it("has five data-tab buttons wired in JS", () => {
    for (const t of ["overview", "facilities", "competitors", "daily", "data"]) {
      expect(HTML).toContain(`data-tab="${t}"`);
    }
    expect(JS).toContain("dataset.tab");
    expect(JS).toMatch(/\[data-tab\]|\.tab/);
    expect(JS).toMatch(/activeTab\s*=/);
  });
});

describe("ZMI BI UI v3 - terminology (OTA, not PMS)", () => {
  it("shows the PMS disclaimer and OTA wording", () => {
    expect(HTML).toContain("PMS実在庫");
    expect(HTML).toContain("OTA販売不可日率");
    // The only occurrence of 稼働率 must be inside the negating disclaimer.
    expect(HTML).toContain("実稼働率ではありません");
  });
  it("does not present occupancy/booking-rate as a metric label", () => {
    // forbidden as standalone metric labels (not the negated disclaimer)
    expect(HTML).not.toContain("在庫率");
    expect(HTML).not.toContain("予約率");
    expect(HTML).not.toContain(">稼働率<");
  });
});

describe("ZMI BI UI v3 - period retention UI", () => {
  it("shows the retention note", () => {
    expect(HTML).toContain("過去は3期分");
  });
  it("JS prefers metadata.default_period_key and supports URL period", () => {
    expect(JS).toContain("default_period_key");
    expect(JS).toContain("pickDefaultPeriodKey");
    expect(JS).toContain("getCurrentPeriodKeyJst");
    expect(JS).toContain("readUrlState");
  });
});

describe("ZMI BI UI v3 - mobile / data loading", () => {
  it("has mobile breakpoints and card/table switch", () => {
    expect(CSS).toContain("max-width:760px");
    expect(CSS).toContain(".desktop-table{display:none}");
    expect(CSS).toContain(".mobile-cards{display:grid}");
    expect(CSS).toContain("overflow-x:hidden");
  });
  it("touch targets are >= 44px", () => {
    expect(CSS).toMatch(/min-height:44px/);
  });
  it("cache-bust fetch of metadata + csv", () => {
    expect(JS).toContain("metadata.json?v=");
    expect(JS).toContain("zmi_market_unified.csv?v=");
    expect(JS).toMatch(/force\s*\?\s*Date\.now\(\)/);
  });
  it("URL state sync for tab/period/group/confidence/q", () => {
    expect(JS).toContain("syncUrlState");
    expect(JS).toMatch(/\.set\("tab"/);
    expect(JS).toMatch(/\.set\("period"/);
    expect(JS).toContain("URLSearchParams");
  });
});

describe("ZMI BI UI v3 - publish dirty flag", () => {
  it("wrangler deploy uses --commit-dirty=true", () => {
    const PUB = readFileSync(resolve(__dirname, "../src/scripts/publishBiWeb.ts"), "utf8");
    expect(PUB).toContain("--commit-dirty=true");
  });
});
