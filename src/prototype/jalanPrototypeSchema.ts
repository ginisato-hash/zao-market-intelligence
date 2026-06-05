import { z } from "zod";

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}, "stay_dates must contain valid YYYY-MM-DD dates");

export const jalanPrototypeSchema = z.object({
  ota: z.literal("jalan"),
  property_name: z.string().min(1),
  property_url: z.string().url(),
  stay_dates: z.array(ymdSchema).min(1).max(2),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
  rooms: z.number().int().min(1),
  nights: z.number().int().min(1)
});

export type JalanPrototypeConfig = z.infer<typeof jalanPrototypeSchema>;

export const jalanMultiDatePrototypeSchema = jalanPrototypeSchema.extend({
  stay_dates: z
    .array(ymdSchema)
    .min(1)
    .max(5)
    .refine((dates) => new Set(dates).size === dates.length, "stay_dates must not contain duplicates"),
  adults: z.literal(2),
  rooms: z.literal(1),
  nights: z.literal(1),
  max_attempts: z.number().int().min(1).max(5),
  delay_ms_between_attempts: z.number().int().min(2_000)
}).superRefine((config, context) => {
  if (config.stay_dates.length > config.max_attempts) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "stay_dates length must not exceed max_attempts",
      path: ["stay_dates"]
    });
  }
});

export type JalanMultiDatePrototypeConfig = z.infer<typeof jalanMultiDatePrototypeSchema>;

export function parseJalanPrototypeConfig(input: unknown): JalanPrototypeConfig {
  if (hasPlaceholderValues(input)) {
    throw new Error(
      "Jalan prototype config still contains placeholder values. Edit data/prototype/jalan.prototype.json with one manually verified Jalan property URL before running."
    );
  }

  return jalanPrototypeSchema.parse(input);
}

export function parseJalanMultiDatePrototypeConfig(input: unknown): JalanMultiDatePrototypeConfig {
  if (hasPlaceholderValues(input)) {
    throw new Error(
      "Jalan multi-date prototype config still contains placeholder values. Edit data/prototype/jalan.multi-date.prototype.json with one manually verified Jalan property URL before running."
    );
  }

  return jalanMultiDatePrototypeSchema.parse(input);
}

function hasPlaceholderValues(input: unknown): boolean {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as Record<string, unknown>;
  return (
    candidate.property_name === "MANUAL_PROPERTY_NAME_REQUIRED" ||
    candidate.property_url === "MANUAL_PROPERTY_URL_REQUIRED" ||
    candidate.property_url === "MANUAL_JALAN_PROPERTY_URL_REQUIRED" ||
    (Array.isArray(candidate.stay_dates) && candidate.stay_dates.includes("YYYY-MM-DD"))
  );
}
