import { z } from "zod";

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}, "verified_at must be a valid YYYY-MM-DD date");

export const jalanVerifiedPropertySeedRecordSchema = z
  .object({
    property_name: z.string().min(1),
    property_url: z.string().regex(/^https:\/\/www\.jalan\.net\/yad[0-9]+\/$/u),
    verification_status: z.enum(["confirmed", "needs_review", "rejected"]),
    verification_method: z.enum(["manual_browser", "targeted_web", "manual_browser_or_targeted_web"]),
    verified_at: ymdSchema.optional(),
    notes: z.string().optional()
  })
  .superRefine((record, context) => {
    if (record.verification_status === "confirmed" && record.verified_at === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verified_at is required when verification_status is confirmed",
        path: ["verified_at"]
      });
    }
  });

export const jalanVerifiedPropertySeedFileSchema = z.array(jalanVerifiedPropertySeedRecordSchema);

export type JalanVerifiedPropertySeedRecord = z.infer<typeof jalanVerifiedPropertySeedRecordSchema>;
