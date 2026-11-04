import { describe, expect, it } from "vitest";
import { ReviewResultSchema } from "../../src/validation/review-result.js";

const validReview = {
  commit_sha: "abc123",
  verdict: "PASS",
  summary: "No blockers identified.",
  findings: [],
  sensitive_categories: [],
  review_complete: true,
};

const validBlocker = {
  id: "finding-001",
  severity: "BLOCKER",
  category: "security",
  file: "src/services/user.ts",
  line: 42,
  title: "Missing authorization validation",
  description: "The operation does not verify caller permissions.",
  impact: "Unauthorized users may modify protected records.",
  suggested_fix: "Add authorization validation.",
  evidence: "The update executes without checking caller permissions.",
  occurrence: "new",
  status: "open",
};

describe("ReviewResultSchema", () => {
  it("accepts a valid PASS review", () => {
    const result = ReviewResultSchema.safeParse(validReview);

    expect(result.success).toBe(true);
  });

  it("accepts a valid FAIL review containing a blocker", () => {
    const result = ReviewResultSchema.safeParse({
      ...validReview,
      verdict: "FAIL",
      summary: "One security blocker identified.",
      findings: [validBlocker],
    });

    expect(result.success).toBe(true);
  });

  it("rejects unsupported severity values", () => {
    const result = ReviewResultSchema.safeParse({
      ...validReview,
      findings: [
        {
          ...validBlocker,
          severity: "CRITICAL",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects findings with missing required properties", () => {
    const result = ReviewResultSchema.safeParse({
      ...validReview,
      findings: [
        {
          id: "finding-001",
          severity: "BLOCKER",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("accepts structurally valid PASS containing an open blocker", () => {
    const result = ReviewResultSchema.safeParse({
      ...validReview,
      findings: [validBlocker],
    });

    expect(result.success).toBe(true);
  });

  it("accepts structurally valid PASS when the review is incomplete", () => {
    const result = ReviewResultSchema.safeParse({
      ...validReview,
      review_complete: false,
    });

    expect(result.success).toBe(true);
  });

  it("accepts FAIL when the review is incomplete", () => {
    const result = ReviewResultSchema.safeParse({
      ...validReview,
      verdict: "FAIL",
      summary: "Review could not be completed.",
      review_complete: false,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid finding line range", () => {
    const result = ReviewResultSchema.safeParse({
      ...validReview,
      verdict: "FAIL",
      findings: [
        {
          ...validBlocker,
          end_line: 30,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects unexpected properties", () => {
    const result = ReviewResultSchema.safeParse({
      ...validReview,
      unexpected_property: "not allowed",
    });

    expect(result.success).toBe(false);
  });
});
