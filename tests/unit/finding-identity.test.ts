import { describe, expect, it } from "vitest";

import {
  generateFindingId,
  deduplicateFindings,
  areEquivalentFindings,
} from "../../src/review/finding-identity.js";

import type { ReviewFinding } from "../../src/validation/review-result.js";

function createFinding(
  id: string,
  title = "Missing authorization validation",
  status: "open" | "resolved" = "open",
  line = 42,
  severity: "BLOCKER" | "WORTH_A_LOOK" | "NIT" = "BLOCKER",
  category: ReviewFinding["category"] = "security",
  file = "src/services/user.ts",
): ReviewFinding {
  return {
    id,
    severity,
    category,
    file,
    line,
    title,
    description: "Authorization is not checked.",
    impact: "Unauthorized access may occur.",
    suggested_fix: "Add authorization validation.",
    evidence: "The operation executes without permission checks.",
    occurrence: "new",
    status,
  };
}

function addAdminBypassEvidence(finding: ReviewFinding): ReviewFinding {
  return {
    ...finding,
    description:
      "The isAdmin function unconditionally returns true regardless of the supplied userId. This allows callers to bypass authorization checks.",
    impact: "Any user can execute privileged administrative operations.",
    suggested_fix:
      "Implement actual administrator role verification instead of returning true.",
    evidence:
      "The isAdmin function executes an unconditional return true without checking permissions.",
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

  it("removes exact duplicate findings", () => {
    const findings = [createFinding("first"), createFinding("second")];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it("removes paraphrased descriptions of the same authorization vulnerability", () => {
    const titles = [
      "Hardcoded true return value in isAdmin bypasses authorization checks",
      "Hardcoded authorization bypass in isAdmin function",
      "Hardcoded true in isAdmin function bypasses access control",
      "isAdmin function unconditionally returns true",
      "Hardcoded admin validation allows unauthorized access",
      "Hardcoded true in isAdmin function causes authorization bypass",
      "Unconditional true return in isAdmin allows complete authorization bypass",
    ];

    const findings = titles.map((title, index) =>
      addAdminBypassEvidence(
        createFinding(`ai-${index}`, title, "open", index % 2 === 0 ? 1 : 2),
      ),
    );

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(6);
    expect(result.findings[0].severity).toBe("BLOCKER");
  });

  it("preserves unrelated findings in the same file", () => {
    const findings = [
      createFinding("first", "Missing authorization validation"),
      createFinding("second", "Missing SQL parameterization in queryUsers"),
    ];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(2);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it("does not merge similar findings from different files", () => {
    const first = addAdminBypassEvidence(
      createFinding(
        "first",
        "Hardcoded authorization bypass in isAdmin",
        "open",
        10,
        "BLOCKER",
        "security",
        "src/services/user.ts",
      ),
    );

    const second = addAdminBypassEvidence(
      createFinding(
        "second",
        "Hardcoded authorization bypass in isAdmin",
        "open",
        10,
        "BLOCKER",
        "security",
        "src/services/admin.ts",
      ),
    );

    expect(areEquivalentFindings(first, second)).toBe(false);

    const result = deduplicateFindings([first, second]);

    expect(result.findings).toHaveLength(2);
  });

  it("does not merge findings from different categories", () => {
    const first = addAdminBypassEvidence(
      createFinding(
        "first",
        "Hardcoded authorization bypass in isAdmin",
        "open",
        10,
        "BLOCKER",
        "security",
      ),
    );

    const second = addAdminBypassEvidence(
      createFinding(
        "second",
        "Hardcoded authorization bypass in isAdmin",
        "open",
        10,
        "BLOCKER",
        "correctness",
      ),
    );

    expect(areEquivalentFindings(first, second)).toBe(false);
  });

  it("does not merge findings at distant code locations", () => {
    const first = addAdminBypassEvidence(
      createFinding(
        "first",
        "Hardcoded authorization bypass in isAdmin",
        "open",
        10,
      ),
    );

    const second = addAdminBypassEvidence(
      createFinding(
        "second",
        "Hardcoded true return value in isAdmin bypasses authorization",
        "open",
        50,
      ),
    );

    expect(areEquivalentFindings(first, second)).toBe(false);

    const result = deduplicateFindings([first, second]);

    expect(result.findings).toHaveLength(2);
  });

  it("prefers an open finding over a resolved duplicate", () => {
    const findings = [
      createFinding("resolved", "Missing authorization validation", "resolved"),
      createFinding("open", "Missing authorization validation", "open"),
    ];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].status).toBe("open");
  });

  it("preserves resolved status when all duplicates are resolved", () => {
    const findings = [
      createFinding(
        "resolved-1",
        "Missing authorization validation",
        "resolved",
      ),
      createFinding(
        "resolved-2",
        "Missing authorization validation",
        "resolved",
      ),
    ];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].status).toBe("resolved");
  });

  it("preserves the highest severity for exact duplicate findings", () => {
    const findings = [
      createFinding(
        "look",
        "Missing authorization validation",
        "open",
        42,
        "WORTH_A_LOOK",
      ),
      createFinding(
        "blocker",
        "Missing authorization validation",
        "open",
        42,
        "BLOCKER",
      ),
    ];

    const result = deduplicateFindings(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("BLOCKER");
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
