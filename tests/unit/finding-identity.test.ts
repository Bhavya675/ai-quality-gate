import { describe, expect, it } from "vitest";
import {
  generateFindingId,
  deduplicateFindings,
} from "../../src/review/finding-identity.js";
import type { ReviewFinding } from "../../src/validation/review-result.js";

function createFinding(
  id: string,
  title = "Missing authorization validation",
  status: "open" | "resolved" = "open",
): ReviewFinding {
  return {
    id,
    severity: "BLOCKER",
    category: "security",
    file: "src/services/user.ts",
    line: 42,
    title,
    description: "Authorization is not checked.",
    impact: "Unauthorized access may occur.",
    suggested_fix: "Add authorization validation.",
    evidence: "The operation executes without permission checks.",
    occurrence: "new",
    status,
  };
}

describe("Finding Identity", () => {
  it("generates a stable ID for the same finding", () => {
    const finding = createFinding("original");

    expect(generateFindingId(finding)).toBe(generateFindingId(finding));
  });

  it("generates the same ID when the line number changes", () => {
    const first = createFinding("first");

    const second = {
      ...first,
      line: 80,
    };

    expect(generateFindingId(first)).toBe(generateFindingId(second));
  });

  it("normalizes file path casing and separators", () => {
    const first = createFinding("first");

    const second = {
      ...first,
      file: "SRC\\SERVICES\\USER.TS",
    };

    expect(generateFindingId(first)).toBe(generateFindingId(second));
  });

  it("generates different IDs for different titles", () => {
    const first = createFinding("first");

    const second = createFinding("second", "Missing input validation");

    expect(generateFindingId(first)).not.toBe(generateFindingId(second));
  });

  it("removes duplicate findings", () => {
    const findings = [createFinding("first"), createFinding("second")];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it("prefers an open finding over a resolved duplicate", () => {
    const findings = [
      createFinding("resolved", undefined, "resolved"),
      createFinding("open", undefined, "open"),
    ];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].status).toBe("open");
  });

  it("preserves resolved status when all duplicates are resolved", () => {
    const findings = [
      createFinding("resolved-1", undefined, "resolved"),
      createFinding("resolved-2", undefined, "resolved"),
    ];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].status).toBe("resolved");
  });

  it("does not remove unrelated findings", () => {
    const findings = [
      createFinding("first"),
      createFinding("second", "Missing input validation"),
    ];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(2);
    expect(result.duplicatesRemoved).toBe(0);
  });
});
