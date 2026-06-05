import { z } from "zod";

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}, "stay_dates must contain valid YYYY-MM-DD dates");

export const rakutenPrototypeSchema = z.object({
  ota: z.literal("rakuten"),
  property_name: z.string().min(1),
  property_url: z.string().regex(/^https:\/\/travel\.rakuten\.co\.jp\/HOTEL\/\d+\/?/u),
  stay_dates: z.array(ymdSchema).min(1).max(2),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
  rooms: z.number().int().min(1),
  nights: z.number().int().min(1)
});

export type RakutenPrototypeConfig = z.infer<typeof rakutenPrototypeSchema>;

export function parseRakutenPrototypeConfig(input: unknown): RakutenPrototypeConfig {
  if (hasPlaceholderValues(input)) {
    throw new Error(
      "Rakuten prototype config still contains placeholder values. Edit data/prototype/rakuten.prototype.json with one manually verified Rakuten property URL before running."
    );
  }

  return rakutenPrototypeSchema.parse(input);
}

function hasPlaceholderValues(input: unknown): boolean {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return (
    candidate.property_name === "MANUAL_PROPERTY_NAME_REQUIRED" ||
    candidate.property_url === "MANUAL_RAKUTEN_PROPERTY_URL_REQUIRED" ||
    (Array.isArray(candidate.stay_dates) && candidate.stay_dates.includes("YYYY-MM-DD"))
  );
}
