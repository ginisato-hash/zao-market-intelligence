import { z } from "zod";

/**
 * Paid sources that must never appear in the coverage map. The project is
 * free/direct-only; paid SERP APIs and paid scraping platforms are forbidden.
 */
export const FORBIDDEN_COVERAGE_SOURCES = [
  "serpapi",
  "dataforseo",
  "apify",
  "brightdata",
  "oxylabs"
] as const;

export const coverageStatusSchema = z.enum([
  "confirmed",
  "needs_review",
  "not_found",
  "blocked",
  "captcha",
  "login_required",
  "unsupported"
]);

const nonBlankString = (label: string) =>
  z.string().refine((value) => value.trim().length > 0, `${label} must not be blank`);

export const propertySourceCoverageSeedRecordSchema = z
  .object({
    property_name: nonBlankString("property_name"),
    source: nonBlankString("source"),
    source_property_id: z.string().optional(),
    property_url: z.string().url("property_url must be a valid URL").optional(),
    coverage_status: coverageStatusSchema,
    access_status: z.string().optional(),
    last_verified_at: z.string().optional(),
    notes: z.string().optional(),
    active: z.boolean().optional()
  })
  .superRefine((record, context) => {
    if (FORBIDDEN_COVERAGE_SOURCES.includes(record.source.trim().toLowerCase() as (typeof FORBIDDEN_COVERAGE_SOURCES)[number])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `source "${record.source}" is a forbidden paid source`,
        path: ["source"]
      });
    }
    // Confirmed rows should be anchored to a URL. The only allowed exception is
    // when notes explicitly document why no URL is available.
    if (record.coverage_status === "confirmed") {
      const hasUrl = record.property_url !== undefined && record.property_url.trim().length > 0;
      const hasReason = record.notes !== undefined && record.notes.trim().length > 0;
      if (!hasUrl && !hasReason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "confirmed rows require property_url unless notes explain the reason",
          path: ["property_url"]
        });
      }
    }
  });

export const propertySourceCoverageSeedFileSchema = z.array(propertySourceCoverageSeedRecordSchema);

export type PropertySourceCoverageSeedRecord = z.infer<typeof propertySourceCoverageSeedRecordSchema>;
