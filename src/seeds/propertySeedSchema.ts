import { z } from "zod";

export const propertyTypeSchema = z.enum([
  "ryokan",
  "hotel",
  "pension",
  "minshuku",
  "lodge",
  "vacation_rental",
  "apartment",
  "guesthouse",
  "unknown"
]);

export const priceSegmentSchema = z.enum(["economy", "midscale", "upper_midscale", "luxury", "unknown"]);
export const mealStyleSchema = z.enum(["room_only", "breakfast", "half_board", "mixed", "unknown"]);
export const skiAccessSchema = z.enum(["ski_in_out", "walkable", "shuttle", "car", "unknown"]);
export const seedOtaSchema = z.enum([
  "jalan",
  "rakuten",
  "yahoo_travel",
  "booking",
  "ikyu",
  "google_hotels",
  "official",
  "other"
]);

export const propertySeedRecordSchema = z.object({
  property_id: z.string().min(1).optional(),
  property_name: z.string().min(1),
  postal_code: z.literal("990-2301"),
  address: z.string().min(1).nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  property_type: propertyTypeSchema,
  price_segment: priceSegmentSchema,
  meal_style: mealStyleSchema,
  has_onsen: z.boolean().nullable(),
  ski_access: skiAccessSchema,
  room_count_estimate: z.number().int().nonnegative().nullable().optional(),
  max_capacity_estimate: z.number().int().nonnegative().nullable().optional(),
  active: z.boolean(),
  notes: z.string().optional()
});

export const propertySeedFileSchema = z.array(propertySeedRecordSchema);

export const propertyOtaLinkSeedRecordSchema = z.object({
  property_name: z.string().min(1),
  ota: seedOtaSchema,
  ota_property_id: z.string().min(1).nullable().optional(),
  property_url: z.string().url().nullable().optional(),
  active: z.boolean(),
  last_verified_at: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().optional()
});

export const propertyOtaLinkSeedFileSchema = z.array(propertyOtaLinkSeedRecordSchema);

export type PropertySeedRecord = z.infer<typeof propertySeedRecordSchema>;
export type PropertyOtaLinkSeedRecord = z.infer<typeof propertyOtaLinkSeedRecordSchema>;
