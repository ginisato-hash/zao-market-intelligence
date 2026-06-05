import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { selectJalanPlannedJobs } from "../src/planner/jalanPlannedJobs";

describe("selectJalanPlannedJobs", () => {
  it("selects only active verified Jalan links and filters priorities", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A", "jalan", 1, "2026-05-29");
    seedProperty(db, "p2", "Property B", "jalan", 0, "2026-05-29");
    seedProperty(db, "p3", "Property C", "rakuten", 1, "2026-05-29");
    seedProperty(db, "p4", "Property D", "jalan", 1, null);
    seedTargetDate(db, "2026-07-18", "S");
    seedTargetDate(db, "2026-07-19", "A");
    seedTargetDate(db, "2026-07-20", "B");

    const jobs = selectJalanPlannedJobs(db, {
      ota: "jalan",
      priorityFilter: ["S", "A"],
      maxJobs: 10,
      adults: 2,
      rooms: 1,
      nights: 1
    });

    expect(jobs.map((job) => `${job.property_name}:${job.priority}:${job.stay_date}`)).toEqual([
      "Property A:S:2026-07-18",
      "Property A:A:2026-07-19"
    ]);
    db.close();
  });

  it("orders S before A, then stay_date, then property_name, and respects maxJobs", () => {
    const db = openDb();
    seedProperty(db, "p2", "Property B", "jalan", 1, "2026-05-29");
    seedProperty(db, "p1", "Property A", "jalan", 1, "2026-05-29");
    seedTargetDate(db, "2026-07-19", "A");
    seedTargetDate(db, "2026-07-18", "S");

    const jobs = selectJalanPlannedJobs(db, {
      ota: "jalan",
      priorityFilter: ["S", "A"],
      maxJobs: 3,
      adults: 2,
      rooms: 1,
      nights: 1
    });

    expect(jobs.map((job) => `${job.priority}:${job.stay_date}:${job.property_name}`)).toEqual([
      "S:2026-07-18:Property A",
      "S:2026-07-18:Property B",
      "A:2026-07-19:Property A"
    ]);
    db.close();
  });
});

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedProperty(
  db: LocalDatabase,
  id: string,
  name: string,
  ota: string,
  linkActive: number,
  lastVerifiedAt: string | null
): void {
  db.prepare(
    `INSERT INTO properties (id, name, postal_code, area_name, active)
     VALUES (?, ?, '990-2301', 'Zao Onsen', 1)`
  ).run(id, name);
  db.prepare(
    `INSERT INTO property_ota_links (id, property_id, ota, property_url, url, active, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(`link_${id}`, id, ota, `https://www.jalan.net/yad${id.replace(/\D/gu, "") || "1"}/`, `https://www.jalan.net/yad${id.replace(/\D/gu, "") || "1"}/`, linkActive, lastVerifiedAt);
}

function seedTargetDate(db: LocalDatabase, stayDate: string, priority: string): void {
  db.prepare(
    `INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active)
     VALUES (?, ?, ?, ?, 1)`
  ).run(`td_${stayDate}`, stayDate, priority, `${priority}_reason`);
}
