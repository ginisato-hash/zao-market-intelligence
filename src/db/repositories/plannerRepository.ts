import type { OtaSource } from "../../domain/types";
import type { LocalDatabase } from "../client";

export interface PlannerPropertyOtaLink {
  propertyId: string;
  propertyName: string;
  ota: OtaSource;
  otaPropertyId: string | null;
  propertyUrl: string | null;
}

interface PlannerPropertyOtaLinkRow {
  property_id: string;
  property_name: string;
  ota: OtaSource;
  ota_property_id: string | null;
  property_url: string | null;
}

export function listActivePropertyOtaLinks(db: LocalDatabase): PlannerPropertyOtaLink[] {
  return db
    .prepare(
      `SELECT
         p.id AS property_id,
         p.name AS property_name,
         l.ota,
         l.ota_property_id,
         l.property_url
       FROM properties p
       INNER JOIN property_ota_links l ON l.property_id = p.id
       WHERE p.active = 1
         AND l.active = 1`
    )
    .all()
    .map((row) => {
      const typed = row as PlannerPropertyOtaLinkRow;
      return {
        propertyId: typed.property_id,
        propertyName: typed.property_name,
        ota: typed.ota,
        otaPropertyId: typed.ota_property_id,
        propertyUrl: typed.property_url
      };
    });
}
