import { z } from "zod";

export const sourceStatusSchema = z.enum([
  "active",
  "parked",
  "feasibility_only",
  "forbidden"
]);

export const sourceTypeSchema = z.enum([
  "direct_ota",
  "metasearch_proxy",
  "official_site",
  "paid_serp_api",
  "paid_scraping_platform",
  "unknown"
]);

export const costPolicySchema = z.enum([
  "free_direct_only",
  "paid_forbidden"
]);

export const confidenceSchema = z.enum(["A", "B", "C", "low", "unknown", "none"]);

export const sourceCapabilitySchema = z.object({
  source: z.string().min(1),
  status: sourceStatusSchema,
  source_type: sourceTypeSchema,
  cost_policy: costPolicySchema,
  confidence: confidenceSchema,
  allowed: z.boolean(),
  paid_service_required: z.boolean(),
  notes: z.string()
})
  .refine(
    (data) => !(data.paid_service_required && data.allowed),
    { message: "paid_service_required=true requires allowed=false" }
  )
  .refine(
    (data) => !(data.status === "forbidden" && data.allowed),
    { message: "status=forbidden requires allowed=false" }
  );

export const sourceCapabilityFileSchema = z.array(sourceCapabilitySchema).min(1);

export type SourceStatus = z.infer<typeof sourceStatusSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type CostPolicy = z.infer<typeof costPolicySchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type SourceCapability = z.infer<typeof sourceCapabilitySchema>;
