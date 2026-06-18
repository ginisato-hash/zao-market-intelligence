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
  it("shows the PMS disclaimer", () => {
    expect(HTML).toContain("PMS実在庫");
    // The only occurrence of 稼働率 must be inside the negating disclaimer.
    expect(HTML).toContain("実稼働率ではありません");
  });
  it("uses 市場の詰まり具合 instead of raw OTA販売不可日率 in the notice", () => {
    expect(HTML).toContain("市場の詰まり具合");
    expect(HTML).not.toContain("OTA販売不可日率");
  });
  it("does not present occupancy/booking-rate as a metric label", () => {
    // forbidden as standalone metric labels (not the negated disclaimer)
    expect(HTML).not.toContain("在庫率");
    expect(HTML).not.toContain("予約率");
    expect(HTML).not.toContain(">稼働率<");
  });
  it("confidence filter options are Japanese (not highのみ/medium以上/lowのみ)", () => {
    expect(HTML).toContain("高のみ");
    expect(HTML).toContain("中以上");
    expect(HTML).toContain("低のみ");
    expect(HTML).not.toContain("highのみ");
    expect(HTML).not.toContain("medium以上");
    expect(HTML).not.toContain("lowのみ");
  });
});

describe("ZMI BI UI - business-readable labels (BI-UX-REFINE01)", () => {
  it("tab labels are business-readable", () => {
    for (const label of ["市場サマリー", "宿ごとの状況", "重点競合", "日別カレンダー", "データの見方"]) {
      expect(HTML, label).toContain(label);
    }
  });
  it("status labels are Japanese in the UI", () => {
    for (const label of ["販売中", "販売不可", "掲載なし", "未観測"]) {
      expect(JS, label).toContain(label);
    }
    // statusLabel helper exists; raw not_found is never rendered as a main label
    expect(JS).toContain("statusLabel");
  });
  it("confidence is shown as 高/中/低 with help text, not raw high/medium/low labels", () => {
    expect(JS).toContain("confidenceLabel");
    expect(JS).toContain("confidenceHelp");
    expect(JS).toContain("価格判断に使いやすい");
    expect(JS).toContain("参考にできる");
    expect(JS).toContain("注意して見る");
  });
  it("market summary KPIs use business wording", () => {
    for (const k of ["平均表示価格", "市場の詰まり具合", "観測できた宿数", "前回より高い宿", "重点競合の確認状況", "最終確認"]) {
      expect(JS, k).toContain(k);
    }
  });
  it("facilities table uses 比較用価格 / 価格帯 / 価格信頼度 / 空き状況信頼度 / 観測サイト数", () => {
    for (const k of ["比較用価格", "価格帯", "価格信頼度", "空き状況信頼度", "観測サイト数"]) {
      expect(JS, k).toContain(k);
    }
  });
  it("price band + market pressure helpers exist", () => {
    expect(JS).toContain("priceBandLabel");
    expect(JS).toContain("marketPressureLabel");
    for (const band of ["安め", "標準", "高め", "かなり高め", "価格なし"]) {
      expect(JS, band).toContain(band);
    }
    for (const p of ["要再確認"]) {
      expect(JS, p).toContain(p);
    }
  });
  it("data-view tab explains the data before raw metadata (collapsible)", () => {
    expect(JS).toContain("データの見方");
    expect(JS).toContain("内部データ詳細を見る");
    expect(JS).toContain("PMS実在庫、実予約数、実稼働率ではありません");
  });
  it("does not main-display source/sold_out_ratio raw wording", () => {
    expect(JS).not.toContain("OTA販売不可日率");
    expect(JS).not.toContain("OTA販売可否");
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

describe("ZMI BI UI - axis labels & captions on every chart/table", () => {
  it("charts/tables render explicit 横軸 / 縦軸 labels", () => {
    expect(JS).toContain("横軸");
    expect(JS).toContain("縦軸");
    expect(JS).toContain("axisBlock");
    expect(JS).toContain("chartCaption");
  });
  it("エリア価格推移 has チェックイン日 x-axis and 表示価格（円） y-axis", () => {
    expect(JS).toContain("エリア価格推移");
    expect(JS).toContain("チェックイン日");
    expect(JS).toContain("表示価格（円）");
  });
  it("daily uses 市場の詰まり具合 axis", () => {
    expect(JS).toContain("市場の詰まり具合");
  });
  it("tables have captions/titles", () => {
    expect(JS).toContain("tableCaption");
    expect(JS).toContain("宿ごとの状況");
    expect(JS).toContain("<caption");
  });
  it("every chartPanel supplies title/description/axis labels/unit", () => {
    for (const k of ["title:", "description:", "xLabel:", "yLabel:", "unit:", "metric:"]) {
      expect(JS, k).toContain(k);
    }
  });
  it("does not use forbidden occupancy/inventory-rate wording (as metrics)", () => {
    // 在庫率 / 予約率 must never appear. 稼働率 only allowed inside the negating
    // PMS disclaimer ("実稼働率ではありません"), never as a metric label.
    for (const bad of ["在庫率", "予約率"]) {
      expect(JS, bad).not.toContain(bad);
      expect(HTML, bad).not.toContain(bad);
    }
    // 稼働率 only inside the negating disclaimer (JS data-view copy + HTML notice).
    expect(JS.replace(/実稼働率ではありません/g, "")).not.toContain("稼働率");
    expect(HTML.replace(/実稼働率ではありません/g, "")).not.toContain("稼働率");
  });
});

describe("ZMI BI UI - Kiraku unified labeling", () => {
  it("mentions the Kiraku all-OTA unification in the UI copy", () => {
    expect(JS).toContain("ZAO SPA HOTEL Kiraku");
  });
});
