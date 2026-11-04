import { describe, expect, it } from "vitest";
import {
  ReviewContextBuilder,
  ReviewContextBuilderError,
  type ReviewContextInput,
} from "../../src/review/review-context-builder.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function createInput(): ReviewContextInput {
  const content = "export const value = 42;";

  return {
    pullRequest: {
      owner: "Bhavya675",
      repository: "ai-quality-gate",
      pullRequestNumber: 12,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [
        {
          filename: "src/example.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: "@@ -1 +1 @@",
        },
      ],
    },
    source: {
      files: [
        {
          path: "src/example.ts",
          status: "modified",
          content,
          sizeBytes: Buffer.byteLength(content, "utf8"),
        },
      ],
      skippedFiles: [],
      totalBytes: Buffer.byteLength(content, "utf8"),
    },
    policy: {
      eligibleFiles: [{ filename: "src/example.ts", status: "modified" }],
      excludedFiles: [],
      sensitiveCategories: [],
    },
    guidelines: "Check correctness, security, and data integrity.",
    policyVersion: "1.0.0",
  };
}

describe("ReviewContextBuilder", () => {
  it("builds a review context with source and PR metadata", () => {
    const result = new ReviewContextBuilder().build(createInput());

    expect(result.headSha).toBe(HEAD_SHA);
    expect(result.policyVersion).toBe("1.0.0");
    expect(result.fileCount).toBe(1);
    expect(result.excludedFileCount).toBe(0);
    expect(result.contextBytes).toBeGreaterThan(0);
    expect(result.systemPrompt).toContain("untrusted input");
    expect(result.userPrompt).toContain("src/example.ts");
    expect(result.userPrompt).toContain("export const value = 42;");
    expect(result.userPrompt).toContain("@@ -1 +1 @@");
  });

  it("includes the configured review guidelines", () => {
    const input = createInput();
    input.guidelines = "Never ignore SQL injection risks.";

    const result = new ReviewContextBuilder().build(input);

    expect(result.userPrompt).toContain("Never ignore SQL injection risks.");
  });

  it("sorts files consistently by path", () => {
    const input = createInput();
    const content = "export const another = true;";

    input.pullRequest.files.push({
      filename: "src/another.ts",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -0,0 +1 @@",
    });

    input.source.files.push({
      path: "src/another.ts",
      status: "added",
      content,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    });

    input.source.totalBytes = input.source.files.reduce(
      (total, file) => total + file.sizeBytes,
      0,
    );

    input.policy.eligibleFiles.push({
      filename: "src/another.ts",
      status: "added",
    });

    const result = new ReviewContextBuilder().build(input);

    expect(result.userPrompt.indexOf("src/another.ts")).toBeLessThan(
      result.userPrompt.indexOf("src/example.ts"),
    );
  });

  it("rejects missing review guidelines", () => {
    const input = createInput();
    input.guidelines = " ";

    expect(() => new ReviewContextBuilder().build(input)).toThrowError(
      ReviewContextBuilderError,
    );
  });

  it("rejects a missing policy version", () => {
    const input = createInput();
    input.policyVersion = " ";

    expect(() => new ReviewContextBuilder().build(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("rejects guidelines exceeding the configured limit", () => {
    const input = createInput();
    input.guidelines = "A".repeat(101);

    const builder = new ReviewContextBuilder({
      maxGuidelineBytes: 100,
    });

    expect(() => builder.build(input)).toThrowError(
      expect.objectContaining({
        code: "GUIDELINES_TOO_LARGE",
      }),
    );
  });

  it("rejects contexts exceeding the configured limit", () => {
    const builder = new ReviewContextBuilder({
      maxContextBytes: 100,
    });

    expect(() => builder.build(createInput())).toThrowError(
      expect.objectContaining({
        code: "CONTEXT_TOO_LARGE",
      }),
    );
  });

  it("rejects source files missing from the policy-approved list", () => {
    const input = createInput();
    input.policy.eligibleFiles = [];

    expect(() => new ReviewContextBuilder().build(input)).toThrowError(
      expect.objectContaining({ code: "SOURCE_MISMATCH" }),
    );
  });

  it("rejects inconsistent source size metadata", () => {
    const input = createInput();
    input.source.totalBytes = 999;

    expect(() => new ReviewContextBuilder().build(input)).toThrowError(
      expect.objectContaining({ code: "SOURCE_MISMATCH" }),
    );
  });

  it("includes excluded files without including their source", () => {
    const input = createInput();

    input.pullRequest.files.push({
      filename: "package-lock.json",
      status: "modified",
      additions: 10,
      deletions: 5,
      changes: 15,
    });

    input.policy.excludedFiles.push({
      filename: "package-lock.json",
      reason: "LOCK_FILE",
    });

    const result = new ReviewContextBuilder().build(input);

    expect(result.fileCount).toBe(1);
    expect(result.excludedFileCount).toBe(1);
    expect(result.userPrompt).toContain("package-lock.json");
    expect(result.userPrompt).toContain("LOCK_FILE");
  });

  it("passes sensitive categories into the review context", () => {
    const input = createInput();
    input.policy.sensitiveCategories = ["auth-identity"];

    const result = new ReviewContextBuilder().build(input);

    expect(result.sensitiveCategories).toContain("auth-identity");
    expect(result.userPrompt).toContain("auth-identity");
  });

  it("rejects source files that include excluded paths", () => {
    const input = createInput();

    input.pullRequest.files.push({
      filename: "package-lock.json",
      status: "modified",
      additions: 10,
      deletions: 5,
      changes: 15,
    });

    input.policy.excludedFiles.push({
      filename: "package-lock.json",
      reason: "LOCK_FILE",
    });

    const content = "{}";

    input.source.files.push({
      path: "package-lock.json",
      status: "modified",
      content,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    });

    input.source.totalBytes += Buffer.byteLength(content, "utf8");

    expect(() => new ReviewContextBuilder().build(input)).toThrowError(
      expect.objectContaining({ code: "SOURCE_MISMATCH" }),
    );
  });
});
