import { z } from "zod";

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}, "stay_date must be a valid YYYY-MM-DD date");

export const targetDateSeedRecordSchema = z.object({
  stay_date: ymdSchema,
  priority: z.enum(["S", "A", "B", "C"]),
  reason: z.string().min(1),
  active: z.boolean()
});

export const targetDateSeedFileSchema = z.array(targetDateSeedRecordSchema);

export type TargetDateSeedRecord = z.infer<typeof targetDateSeedRecordSchema>;
