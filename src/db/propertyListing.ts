import type { LocalDatabase } from "./client";

export interface PropertyListingSummary {
  totalProperties: number;
  activeProperties: number;
  countByPropertyType: Record<string, number>;
  countByPriceSegment: Record<string, number>;
  countByMealStyle: Record<string, number>;
  otaLinkCountByOta: Record<string, number>;
  propertiesMissingAllActiveOtaLinks: string[];
}

interface CountRow {
  count: number;
}

interface GroupCountRow {
  key: string;
  count: number;
}

interface PropertyNameRow {
  name: string;
}

export function getPropertyListingSummary(db: LocalDatabase): PropertyListingSummary {
  return {
    totalProperties: count(db, "SELECT COUNT(*) AS count FROM properties"),
    activeProperties: count(db, "SELECT COUNT(*) AS count FROM properties WHERE active = 1"),
    countByPropertyType: groupCount(db, "SELECT property_type AS key, COUNT(*) AS count FROM properties GROUP BY property_type ORDER BY property_type"),
    countByPriceSegment: groupCount(db, "SELECT price_segment AS key, COUNT(*) AS count FROM properties GROUP BY price_segment ORDER BY price_segment"),
    countByMealStyle: groupCount(db, "SELECT meal_style AS key, COUNT(*) AS count FROM properties GROUP BY meal_style ORDER BY meal_style"),
    otaLinkCountByOta: groupCount(db, "SELECT ota AS key, COUNT(*) AS count FROM property_ota_links GROUP BY ota ORDER BY ota"),
    propertiesMissingAllActiveOtaLinks: db
      .prepare(
        `SELECT p.name
         FROM properties p
         WHERE p.active = 1
           AND NOT EXISTS (
             SELECT 1
             FROM property_ota_links l
             WHERE l.property_id = p.id
               AND l.active = 1
           )
         ORDER BY p.name`
      )
      .all()
      .map((row) => (row as PropertyNameRow).name)
  };
}

function count(db: LocalDatabase, sql: string): number {
  return (db.prepare(sql).get() as CountRow).count;
}

function groupCount(db: LocalDatabase, sql: string): Record<string, number> {
  return Object.fromEntries(
    db
      .prepare(sql)
      .all()
      .map((row) => {
        const typed = row as GroupCountRow;
        return [typed.key, typed.count];
      })
  );
}
