import { z } from "zod";
import { ReviewFindingSchema } from "../validation/review-result.js";

export const ReviewStateKeySchema = z
  .object({
    repository: z.string().min(1),
    pullRequestNumber: z.number().int().positive(),
  })
  .strict();

export type ReviewStateKey = z.infer<typeof ReviewStateKeySchema>;

export const ReviewStateSchema = z
  .object({
    schemaVersion: z.literal(1),

    repository: z.string().min(1),
    pullRequestNumber: z.number().int().positive(),

    baseSha: z.string().min(1),
    headSha: z.string().min(1),

    policyVersion: z.string().min(1),
    guidelinesSha: z.string().min(1),

    verdict: z.enum(["PASS", "FAIL"]),
    findings: z.array(ReviewFindingSchema),

    updatedAt: z.string().datetime(),
  })
  .strict();

export type ReviewState = z.infer<typeof ReviewStateSchema>;
