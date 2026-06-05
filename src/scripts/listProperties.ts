import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import { getPropertyListingSummary } from "../db/propertyListing";

const db = openLocalDatabase();

try {
  executeMigration(db);
  const summary = getPropertyListingSummary(db);

  console.log(`total_properties=${summary.totalProperties}`);
  console.log(`active_properties=${summary.activeProperties}`);
  console.log(`count_by_property_type=${JSON.stringify(summary.countByPropertyType)}`);
  console.log(`count_by_price_segment=${JSON.stringify(summary.countByPriceSegment)}`);
  console.log(`count_by_meal_style=${JSON.stringify(summary.countByMealStyle)}`);
  console.log(`ota_link_count_by_ota=${JSON.stringify(summary.otaLinkCountByOta)}`);
  console.log(`properties_missing_all_active_ota_links=${JSON.stringify(summary.propertiesMissingAllActiveOtaLinks)}`);
} finally {
  closeDatabase(db);
}
