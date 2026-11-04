import { z } from "zod";

// Overall AI review verdict.
export const ReviewVerdictSchema = z.enum(["PASS", "FAIL"]);

// Finding severity.
export const FindingSeveritySchema = z.enum(["BLOCKER", "WORTH_A_LOOK", "NIT"]);

// Categories used to classify review findings.
export const FindingCategorySchema = z.enum([
  "correctness",
  "security",
  "data-loss",
  "database",
  "api-contract",
  "testing",
  "observability",
  "guidelines",
  "human-feedback",
  "performance",
  "architecture",
  "other",
]);

// Independent sensitive-domain classification.
export const SensitiveCategorySchema = z.enum([
  "auth-identity",
  "money-movement",
  "ledger-reconciliation",
  "card-lifecycle",
  "customer-personal-data",
  "permissions-limits",
  "external-scheme-integration",
]);

export const FindingStatusSchema = z.enum(["open", "resolved"]);

export const FindingOccurrenceSchema = z.enum(["new", "previously_reported"]);

// Individual review finding.
export const ReviewFindingSchema = z
  .object({
    id: z.string().min(1),

    severity: FindingSeveritySchema,

    category: FindingCategorySchema,

    file: z.string().min(1),

    line: z.number().int().positive(),

    end_line: z.number().int().positive().optional(),

    title: z.string().min(1),

    description: z.string().min(1),

    impact: z.string().min(1),

    suggested_fix: z.string().min(1),

    evidence: z.string().min(1),

    occurrence: FindingOccurrenceSchema,

    status: FindingStatusSchema,
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.end_line !== undefined && finding.end_line < finding.line) {
      context.addIssue({
        code: "custom",
        path: ["end_line"],
        message: "end_line cannot be less than line.",
      });
    }
  });

// Complete AI review result.

// export const ReviewResultSchema = z
//   .object({
//     commit_sha: z.string().min(1),

//     verdict: ReviewVerdictSchema,

//     summary: z.string().min(1),

//     findings: z.array(ReviewFindingSchema),

//     sensitive_categories: z.array(SensitiveCategorySchema),

//     review_complete: z.boolean(),
//   })
//   .strict()
//   .superRefine((review, context) => {
//     const blockerExists = review.findings.some(
//       (finding) => finding.severity === "BLOCKER" && finding.status === "open",
//     );

//     if (blockerExists && review.verdict === "PASS") {
//       context.addIssue({
//         code: "custom",
//         path: ["verdict"],
//         message:
//           "A review containing an open blocker cannot have a PASS verdict.",
//       });
//     }

//     if (!review.review_complete && review.verdict === "PASS") {
//       context.addIssue({
//         code: "custom",
//         path: ["review_complete"],
//         message: "An incomplete review cannot have a PASS verdict.",
//       });
//     }
//   });

export const ReviewResultSchema = z
  .object({
    commit_sha: z.string().min(1),

    verdict: ReviewVerdictSchema,

    summary: z.string().min(1),

    findings: z.array(ReviewFindingSchema),

    sensitive_categories: z.array(SensitiveCategorySchema),

    review_complete: z.boolean(),
  })
  .strict();

// TypeScript types inferred directly from Zod schemas.
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export type SensitiveCategory = z.infer<typeof SensitiveCategorySchema>;

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
