import { z } from "zod";
import { normalizePropertyName } from "../services/propertyAliasResolver";

export const propertyAliasSeedRecordSchema = z.object({
  canonical_property_name: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).min(1),
  status: z.enum(["confirmed", "needs_review", "rejected"]),
  notes: z.string().optional()
});

export const propertyAliasSeedFileSchema = z.array(propertyAliasSeedRecordSchema).superRefine((records, context) => {
  const canonicalNames = new Map<string, number>();
  const aliases = new Map<string, Array<{ index: number; status: string }>>();

  records.forEach((record, index) => {
    const canonicalKey = normalizePropertyName(record.canonical_property_name);
    const existingCanonical = canonicalNames.get(canonicalKey);
    if (existingCanonical !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "canonical_property_name must not be duplicated",
        path: [index, "canonical_property_name"]
      });
    }
    canonicalNames.set(canonicalKey, index);

    for (const alias of record.aliases) {
      const aliasKey = normalizePropertyName(alias);
      const bucket = aliases.get(aliasKey) ?? [];
      bucket.push({ index, status: record.status });
      aliases.set(aliasKey, bucket);
    }
  });

  for (const [aliasKey, owners] of aliases.entries()) {
    const ownerIndexes = new Set(owners.map((owner) => owner.index));
    const hasNeedsReview = owners.some((owner) => owner.status === "needs_review");
    if (ownerIndexes.size > 1 && !hasNeedsReview) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `alias must not appear under multiple canonical names unless status is needs_review: ${aliasKey}`,
        path: []
      });
    }
  }
});

export type PropertyAliasSeedRecord = z.infer<typeof propertyAliasSeedRecordSchema>;
