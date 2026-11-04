import { describe, expect, it } from "vitest";
import {
  verifyFindingResolution,
  FindingResolutionVerifierError,
} from "../../src/review/finding-resolution-verifier.js";
import type { ReviewFinding } from "../../src/validation/review-result.js";

const HEAD_SHA = "commit-123";

function createFinding(): ReviewFinding {
  return {
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
    occurrence: "previously_reported",
    status: "open",
  };
}

describe("FindingResolutionVerifier", () => {
  it("rejects automatic resolution until source-code verification exists", () => {
    expect(() =>
      verifyFindingResolution(
        createFinding(),
        {
          findingId: "finding-001",
          decision: "CONFIRMED_FIXED",
          evidence: "Authorization validation is now enforced.",
          verifiedCommitSha: HEAD_SHA,
        },
        HEAD_SHA,
      ),
    ).toThrow("Automatic resolution is disabled until source-code verification is implemented.");
  });

  it("keeps a finding open when the issue is still present", () => {
    const result = verifyFindingResolution(
      createFinding(),
      {
        findingId: "finding-001",
        decision: "STILL_PRESENT",
        evidence: "The update operation still lacks authorization validation.",
        verifiedCommitSha: HEAD_SHA,
      },
      HEAD_SHA,
    );

    expect(result.finding.status).toBe("open");
  });

  it("keeps a finding open when resolution is unverified", () => {
    const result = verifyFindingResolution(
      createFinding(),
      {
        findingId: "finding-001",
        decision: "UNVERIFIED",
        evidence:
          "The available code changes do not establish whether the issue is fixed.",
        verifiedCommitSha: HEAD_SHA,
      },
      HEAD_SHA,
    );

    expect(result.finding.status).toBe("open");
  });

  it("rejects evidence from a different commit", () => {
    expect(() =>
      verifyFindingResolution(
        createFinding(),
        {
          findingId: "finding-001",
          decision: "CONFIRMED_FIXED",
          evidence: "Authorization validation is now enforced.",
          verifiedCommitSha: "old-commit",
        },
        HEAD_SHA,
      ),
    ).toThrow(FindingResolutionVerifierError);
  });

  it("rejects empty evidence", () => {
    expect(() =>
      verifyFindingResolution(
        createFinding(),
        {
          findingId: "finding-001",
          decision: "CONFIRMED_FIXED",
          evidence: "   ",
          verifiedCommitSha: HEAD_SHA,
        },
        HEAD_SHA,
      ),
    ).toThrow("Resolution evidence must not be empty.");
  });

  it("rejects an empty expected commit SHA", () => {
    expect(() =>
      verifyFindingResolution(
        createFinding(),
        {
          findingId: "finding-001",
          decision: "CONFIRMED_FIXED",
          evidence: "Authorization validation is now enforced.",
          verifiedCommitSha: HEAD_SHA,
        },
        " ",
      ),
    ).toThrow("Expected commit SHA is required.");
  });

  it("does not mutate the original finding", () => {
    const original = createFinding();

    verifyFindingResolution(
      original,
      {
        findingId: "finding-001",
        decision: "UNVERIFIED",
        evidence: "The available code changes do not establish whether the issue is fixed.",
        verifiedCommitSha: HEAD_SHA,
      },
      HEAD_SHA,
    );

    expect(original.status).toBe("open");
  });
});
