import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openLocalDatabase } from "../src/db/client";
import {
  buildJalanVerificationChecklist,
  formatJalanVerificationChecklist
} from "../src/scripts/printJalanVerificationChecklist";

describe("printJalanVerificationChecklist", () => {
  it("prints properties missing Jalan URLs", () => {
    const db = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "jalan-checklist-")), "test.sqlite"));
    const propertySeedPath = writeJson("properties", [
      property("ル・ベール蔵王"),
      property("未確認の宿")
    ]);
    const verifiedSeedPath = writeJson("verified", [
      {
        property_name: "ル・ベール蔵王",
        property_url: "https://www.jalan.net/yad328232/",
        verification_status: "confirmed",
        verification_method: "targeted_web",
        verified_at: "2026-05-28"
      }
    ]);
    const aliasSeedPath = writeJson("aliases", []);

    try {
      const output = formatJalanVerificationChecklist(
        buildJalanVerificationChecklist({ db, propertySeedPath, verifiedSeedPath, aliasSeedPath })
      );

      expect(output).toContain("confirmed_jalan_url_count=1");
      expect(output).toContain("未確認の宿");
      expect(output).toContain("properties_with_no_jalan_url_count=1");
    } finally {
      closeDatabase(db);
    }
  });

  it("prints confirmed aliases as resolved duplicate names", () => {
    const db = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "jalan-checklist-")), "test.sqlite"));
    const propertySeedPath = writeJson("properties", [
      property("深山荘 高見屋")
    ]);
    const verifiedSeedPath = writeJson("verified", [
      {
        property_name: "深山荘 高見屋 −MIYAMASO TAKAMIYA−",
        property_url: "https://www.jalan.net/yad321744/",
        verification_status: "confirmed",
        verification_method: "targeted_web",
        verified_at: "2026-05-28"
      }
    ]);
    const aliasSeedPath = writeJson("aliases", [
      {
        canonical_property_name: "深山荘 高見屋 −MIYAMASO TAKAMIYA−",
        aliases: ["深山荘 高見屋"],
        status: "confirmed"
      }
    ]);

    try {
      const output = formatJalanVerificationChecklist(
        buildJalanVerificationChecklist({ db, propertySeedPath, verifiedSeedPath, aliasSeedPath })
      );

      expect(output).toContain("duplicate_candidate_names_count=1");
      expect(output).toContain("alias_resolved_count=1");
      expect(output).toContain("unresolved_duplicate_candidate_count=0");
      expect(output).toContain("深山荘 高見屋 | 深山荘 高見屋 −MIYAMASO TAKAMIYA−");
    } finally {
      closeDatabase(db);
    }
  });

  it("prints unresolved duplicate candidates separately", () => {
    const db = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "jalan-checklist-")), "test.sqlite"));
    const propertySeedPath = writeJson("properties", [
      property("蔵王温泉ホテル A"),
      property("蔵王温泉ホテル A 別館")
    ]);
    const verifiedSeedPath = writeJson("verified", []);
    const aliasSeedPath = writeJson("aliases", []);

    try {
      const output = formatJalanVerificationChecklist(
        buildJalanVerificationChecklist({ db, propertySeedPath, verifiedSeedPath, aliasSeedPath })
      );

      expect(output).toContain("unresolved_duplicate_candidate_count=1");
      expect(output).toContain("蔵王温泉ホテル A | 蔵王温泉ホテル A 別館");
    } finally {
      closeDatabase(db);
    }
  });
});

function writeJson(prefix: string, value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), `jalan-${prefix}-`)), `${prefix}.json`);
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function property(propertyName: string) {
  return {
    property_name: propertyName,
    postal_code: "990-2301",
    property_type: "unknown",
    price_segment: "unknown",
    meal_style: "unknown",
    has_onsen: null,
    ski_access: "unknown",
    active: true
  };
}
