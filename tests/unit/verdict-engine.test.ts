import { describe, expect, it } from "vitest";
import { calculateVerdict } from "../../src/review/verdict-engine.js";
import type {
  ReviewFinding,
  ReviewResult,
} from "../../src/validation/review-result.js";

const createFinding = (
  severity: ReviewFinding["severity"],
  id: string,
): ReviewFinding => ({
  id,
  severity,
  category: "correctness",
  file: "src/example.ts",
  line: 10,
  title: "Example finding",
  description: "Example description.",
  impact: "Example impact.",
  suggested_fix: "Example fix.",
  evidence: "Example evidence.",
  occurrence: "new",
  status: "open",
});

const createReview = (
  findings: ReviewFinding[] = [],
  reviewComplete = true,
): ReviewResult => ({
  commit_sha: "abc123",
  verdict: "PASS",
  summary: "Test review.",
  findings,
  sensitive_categories: [],
  review_complete: reviewComplete,
});

describe("Verdict Engine", () => {
  it("returns PASS when there are no blockers", () => {
    const result = calculateVerdict(createReview());

    expect(result.verdict).toBe("PASS");
  });

  it("returns FAIL when an open blocker exists", () => {
    const result = calculateVerdict(
      createReview([createFinding("BLOCKER", "finding-001")]),
    );

    expect(result.verdict).toBe("FAIL");
    expect(result.blockerCount).toBe(1);
  });

  it("returns PASS for worth-a-look findings only", () => {
    const result = calculateVerdict(
      createReview([createFinding("WORTH_A_LOOK", "finding-001")]),
    );

    expect(result.verdict).toBe("PASS");
  });

  it("returns PASS for nit findings only", () => {
    const result = calculateVerdict(
      createReview([createFinding("NIT", "finding-001")]),
    );

    expect(result.verdict).toBe("PASS");
  });

  it("returns FAIL when the review is incomplete", () => {
    const result = calculateVerdict(createReview([], false));

    expect(result.verdict).toBe("FAIL");
  });

  it("ignores resolved blockers when calculating verdict", () => {
    const blocker = {
      ...createFinding("BLOCKER", "finding-001"),
      status: "resolved" as const,
    };

    const result = calculateVerdict(createReview([blocker]));

    expect(result.verdict).toBe("PASS");
    expect(result.blockerCount).toBe(0);
  });

  it("counts multiple findings independently", () => {
    const result = calculateVerdict(
      createReview([
        createFinding("BLOCKER", "finding-001"),
        createFinding("WORTH_A_LOOK", "finding-002"),
        createFinding("NIT", "finding-003"),
      ]),
    );

    expect(result.verdict).toBe("FAIL");
    expect(result.blockerCount).toBe(1);
    expect(result.worthALookCount).toBe(1);
    expect(result.nitCount).toBe(1);
  });
});
