import { describe, expect, it } from "vitest";

import {
  ReviewStateKeySchema,
  ReviewStateSchema,
} from "../../src/storage/review-state.js";

const validState = {
  schemaVersion: 1 as const,
  repository: "Bhavya675/ai-quality-gate",
  pullRequestNumber: 10,
  baseSha: "base123",
  headSha: "head123",
  policyVersion: "v1",
  guidelinesSha: "guidelines123",
  verdict: "FAIL" as const,
  findings: [],
  updatedAt: "2026-11-03T10:00:00.000Z",
};

describe("ReviewStateKeySchema", () => {
  it("accepts a valid repository and pull request", () => {
    const result = ReviewStateKeySchema.safeParse({
      repository: "Bhavya675/ai-quality-gate",
      pullRequestNumber: 10,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an empty repository", () => {
    const result = ReviewStateKeySchema.safeParse({
      repository: "",
      pullRequestNumber: 10,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid pull request number", () => {
    const result = ReviewStateKeySchema.safeParse({
      repository: "Bhavya675/ai-quality-gate",
      pullRequestNumber: 0,
    });

    expect(result.success).toBe(false);
  });
});

describe("ReviewStateSchema", () => {
  it("accepts a valid review state", () => {
    const result = ReviewStateSchema.safeParse(validState);

    expect(result.success).toBe(true);
  });

  it("rejects an unsupported schema version", () => {
    const result = ReviewStateSchema.safeParse({
      ...validState,
      schemaVersion: 2,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid verdict", () => {
    const result = ReviewStateSchema.safeParse({
      ...validState,
      verdict: "UNKNOWN",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing commit SHA", () => {
    const result = ReviewStateSchema.safeParse({
      ...validState,
      headSha: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid timestamp", () => {
    const result = ReviewStateSchema.safeParse({
      ...validState,
      updatedAt: "not-a-date",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unexpected properties", () => {
    const result = ReviewStateSchema.safeParse({
      ...validState,
      secret: "unexpected",
    });

    expect(result.success).toBe(false);
  });
});
