import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openLocalDatabase } from "../src/db/client";
import { importJalanVerifiedProperties } from "../src/seeds/importJalanVerifiedProperties";

describe("importJalanVerifiedProperties", () => {
  it("creates properties and active confirmed Jalan links idempotently", () => {
    const db = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "jalan-verified-")), "test.sqlite"));
    const seedPath = writeSeed([
      seed("ル・ベール蔵王", "https://www.jalan.net/yad328232/", "confirmed"),
      seed("Needs Review", "https://www.jalan.net/yad111111/", "needs_review"),
      seed("Rejected", "https://www.jalan.net/yad222222/", "rejected")
    ]);

    try {
      const first = importJalanVerifiedProperties({ db, seedPath });
      const second = importJalanVerifiedProperties({ db, seedPath });

      expect(first.propertiesInserted).toBe(3);
      expect(first.otaLinksInserted).toBe(3);
      expect(second.propertiesUpdated).toBe(3);
      expect(second.otaLinksUpdated).toBe(3);
      expect(first.confirmedCount).toBe(1);
      expect(first.needsReviewCount).toBe(1);
      expect(first.rejectedCount).toBe(1);

      const rows = db
        .prepare(
          `SELECT p.name, pol.active
           FROM property_ota_links pol
           JOIN properties p ON p.id = pol.property_id
           WHERE pol.ota = 'jalan'
           ORDER BY p.name`
        )
        .all() as Array<{ name: string; active: number }>;

      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.name === "ル・ベール蔵王")?.active).toBe(1);
      expect(rows.find((row) => row.name === "Needs Review")?.active).toBe(0);
      expect(rows.find((row) => row.name === "Rejected")?.active).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it("resolves confirmed aliases before upserting", () => {
    const db = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "jalan-verified-")), "test.sqlite"));
    const seedPath = writeSeed([
      seed("深山荘 高見屋", "https://www.jalan.net/yad321744/", "confirmed")
    ]);
    const aliasSeedPath = writeJson("aliases", [
      {
        canonical_property_name: "深山荘 高見屋 −MIYAMASO TAKAMIYA−",
        aliases: ["深山荘 高見屋"],
        status: "confirmed"
      }
    ]);

    try {
      const summary = importJalanVerifiedProperties({ db, seedPath, aliasSeedPath });

      expect(summary.aliasResolvedCount).toBe(1);
      expect(summary.propertiesInserted).toBe(1);
      expect(summary.aliasResolutions[0]).toEqual({
        inputName: "深山荘 高見屋",
        canonicalName: "深山荘 高見屋 −MIYAMASO TAKAMIYA−"
      });

      const row = db
        .prepare(
          `SELECT p.name, pol.active
           FROM property_ota_links pol
           JOIN properties p ON p.id = pol.property_id
           WHERE pol.ota = 'jalan'`
        )
        .get() as { name: string; active: number };

      expect(row.name).toBe("深山荘 高見屋 −MIYAMASO TAKAMIYA−");
      expect(row.active).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it("skips ambiguous aliases for manual review", () => {
    const db = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "jalan-verified-")), "test.sqlite"));
    const seedPath = writeSeed([
      seed("共通名", "https://www.jalan.net/yad333333/", "confirmed")
    ]);
    const aliasSeedPath = writeJson("aliases", [
      {
        canonical_property_name: "宿 A",
        aliases: ["共通名"],
        status: "needs_review"
      }
    ]);

    try {
      const summary = importJalanVerifiedProperties({ db, seedPath, aliasSeedPath });

      expect(summary.ambiguousAliasSkippedCount).toBe(1);
      expect(summary.needsReviewCount).toBe(1);
      expect(summary.propertiesInserted).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM property_ota_links").get()).toEqual({ count: 0 });
    } finally {
      closeDatabase(db);
    }
  });
});

function writeSeed(records: unknown[]): string {
  return writeJson("seed", records);
}

function writeJson(prefix: string, value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "jalan-verified-seed-")), "seed.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function seed(propertyName: string, propertyUrl: string, verificationStatus: "confirmed" | "needs_review" | "rejected") {
  return {
    property_name: propertyName,
    property_url: propertyUrl,
    verification_status: verificationStatus,
    verification_method: "targeted_web",
    ...(verificationStatus === "confirmed" ? { verified_at: "2026-05-28" } : {}),
    notes: "test"
  };
}
