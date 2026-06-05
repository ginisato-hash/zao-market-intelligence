import { z } from "zod";

export const pricingTargetSchema = z.object({
  target_id: z.string().trim().min(1),
  property_name: z.string().trim().min(1),
  postal_code: z.string().trim().min(1),
  source_market: z.literal("jalan"),
  baseline_adr_jpy: z.number().int().positive(),
  min_price_jpy: z.number().int().positive(),
  max_price_jpy: z.number().int().positive(),
  rounding_unit_jpy: z.union([z.literal(100), z.literal(500), z.literal(1000)]),
  strategy: z.enum(["follow_quality_adjusted_market", "baseline_with_priority_multiplier"]),
  active: z.boolean()
}).refine((record) => record.max_price_jpy >= record.min_price_jpy, {
  path: ["max_price_jpy"],
  message: "max_price_jpy must be greater than or equal to min_price_jpy"
});

export const pricingTargetSeedSchema = z.array(pricingTargetSchema);

export type PricingTargetConfig = z.infer<typeof pricingTargetSchema>;

export function parsePricingTargetSeed(input: unknown): PricingTargetConfig[] {
  return pricingTargetSeedSchema.parse(input);
}
