import { z } from "zod";

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}, "stay_dates must contain valid YYYY-MM-DD dates");

const jalanPropertyEntrySchema = z.object({
  property_name: z.string().min(1),
  property_url: z
    .string()
    .regex(/^https:\/\/www\.jalan\.net\/yad\d+\/$/, "property_url must be https://www.jalan.net/yadXXXXXX/")
});

export const jalanFivePropertyBatchSchema = z.object({
  ota: z.literal("jalan"),
  properties: z
    .array(jalanPropertyEntrySchema)
    .length(5, "exactly 5 properties required")
    .refine((props) => new Set(props.map((p) => p.property_url)).size === props.length, "property URLs must be unique"),
  stay_dates: z
    .array(ymdSchema)
    .length(3, "exactly 3 stay_dates required")
    .refine((dates) => new Set(dates).size === dates.length, "stay_dates must not contain duplicates"),
  adults: z.literal(2),
  children: z.number().int().min(0),
  rooms: z.literal(1),
  nights: z.literal(1),
  max_jobs: z.number().int().min(1).max(15),
  delay_ms_between_jobs: z.number().int().min(3000)
});

export type JalanFivePropertyBatchConfig = z.infer<typeof jalanFivePropertyBatchSchema>;

export function parseJalanFivePropertyBatchConfig(input: unknown): JalanFivePropertyBatchConfig {
  return jalanFivePropertyBatchSchema.parse(input);
}
