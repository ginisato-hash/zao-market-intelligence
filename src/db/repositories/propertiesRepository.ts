import { ZAO_POSTAL_CODE } from "../../domain/constants";
import type { LocalDatabase } from "../client";

export function ensureProperty(db: LocalDatabase, propertyId: string, name = propertyId): void {
  db.prepare(
    `INSERT OR IGNORE INTO properties (id, name, postal_code, area_name)
     VALUES (@id, @name, @postalCode, @areaName)`
  ).run({
    id: propertyId,
    name,
    postalCode: ZAO_POSTAL_CODE,
    areaName: "Zao Onsen"
  });
}

export function propertyExists(db: LocalDatabase, propertyId: string): boolean {
  return db.prepare("SELECT 1 FROM properties WHERE id = ?").get(propertyId) !== undefined;
}
