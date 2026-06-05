import { z } from "zod";
import { isAllowedSource, normalizeSourceToken, OTHER_SOURCE } from "../services/sourceVocabulary";
import { FORBIDDEN_COVERAGE_SOURCES } from "./propertySourceCoverageSeedSchema";

/**
 * A source-coverage *candidate* is a verification TODO: a property/source pair
 * we want to track before we know a usable URL or source id. Candidates live in
 * their own table and never become active coverage automatically — only rows
 * promoted to verification_status "confirmed" (or explicitly "needs_review")
 * should later flow into property_source_coverage, and that promotion is a
 * deliberate, separate step (Phase 43X).
 */
export const candidateVerificationStatusSchema = z.enum([
  "candidate",
  "confirmed",
  "rejected",
  "needs_review"
]);

const nonBlankString = (label: string) =>
  z.string().refine((value) => value.trim().length > 0, `${label} must not be blank`);

const optionalNullableString = z
  .string()
  .nullish()
  .transform((value) => (value === undefined ? null : value));

export const sourceCoverageCandidateRecordSchema = z
  .object({
    property_name: nonBlankString("property_name"),
    source: nonBlankString("source"),
    candidate_property_url: z
      .string()
      .url("candidate_property_url must be a valid URL")
      .nullish()
      .transform((value) => (value === undefined ? null : value)),
    candidate_source_property_id: optionalNullableString,
    candidate_label: optionalNullableString,
    evidence_note: nonBlankString("evidence_note"),
    verification_status: candidateVerificationStatusSchema,
    reviewer_note: optionalNullableString
  })
  .superRefine((record, context) => {
    const token = normalizeSourceToken(record.source);
    if (FORBIDDEN_COVERAGE_SOURCES.includes(token as (typeof FORBIDDEN_COVERAGE_SOURCES)[number])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `source "${record.source}" is a forbidden paid source`,
        path: ["source"]
      });
      return;
    }
    if (!isAllowedSource(record.source)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `source "${record.source}" is not a canonical source (use a canonical name or "${OTHER_SOURCE}")`,
        path: ["source"]
      });
    }
    // source="other" requires stronger evidence so the row stays auditable
    if (normalizeSourceToken(record.source) === OTHER_SOURCE) {
      if (record.evidence_note.trim().length < 30) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `evidence_note must be at least 30 characters when source is "${OTHER_SOURCE}"`,
          path: ["evidence_note"]
        });
      }
      if (record.candidate_label === null || record.candidate_label.trim().length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `candidate_label must not be blank when source is "${OTHER_SOURCE}"`,
          path: ["candidate_label"]
        });
      }
      if (
        record.verification_status === "confirmed" &&
        (record.reviewer_note === null || record.reviewer_note.trim().length === 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `reviewer_note must not be blank when source is "${OTHER_SOURCE}" and verification_status is "confirmed"`,
          path: ["reviewer_note"]
        });
      }
    }
  });

export const sourceCoverageCandidateFileSchema = z.array(sourceCoverageCandidateRecordSchema);

export type SourceCoverageCandidateRecord = z.infer<typeof sourceCoverageCandidateRecordSchema>;
