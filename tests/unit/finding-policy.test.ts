import { describe, expect, it } from "vitest";
import { applyFindingPolicy } from "../../src/review/finding-policy.js";
import type { ReviewFinding } from "../../src/validation/review-result.js";

function createFinding(
  severity: ReviewFinding["severity"],
  id: string,
): ReviewFinding {
  return {
    id,
    severity,
    category: "correctness",
    file: "src/example.ts",
    line: 10,
    title: `Finding ${id}`,
    description: "Example description.",
    impact: "Example impact.",
    suggested_fix: "Example fix.",
    evidence: "Example evidence.",
    occurrence: "new",
    status: "open",
  };
}

describe("Finding Policy", () => {
  it("retains all blockers", () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      createFinding("BLOCKER", `blocker-${i}`),
    );

    const result = applyFindingPolicy(findings);

    expect(result.findings).toHaveLength(10);
  });

  it("retains at most five worth-a-look findings", () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      createFinding("WORTH_A_LOOK", `look-${i}`),
    );

    const result = applyFindingPolicy(findings);

    expect(result.findings).toHaveLength(5);
    expect(result.omittedWorthALook).toBe(3);
  });

  it("retains at most three nits", () => {
    const findings = Array.from({ length: 6 }, (_, i) =>
      createFinding("NIT", `nit-${i}`),
    );

    const result = applyFindingPolicy(findings);

    expect(result.findings).toHaveLength(3);
    expect(result.omittedNits).toBe(3);
  });

  it("retains blockers and applies advisory limits independently", () => {
    const findings = [
      ...Array.from({ length: 7 }, (_, i) =>
        createFinding("BLOCKER", `blocker-${i}`),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        createFinding("WORTH_A_LOOK", `look-${i}`),
      ),
      ...Array.from({ length: 5 }, (_, i) => createFinding("NIT", `nit-${i}`)),
    ];

    const result = applyFindingPolicy(findings);

    expect(result.findings).toHaveLength(15);
    expect(result.omittedWorthALook).toBe(2);
    expect(result.omittedNits).toBe(2);
  });

  it("preserves all findings when they are within limits", () => {
    const findings = [
      createFinding("BLOCKER", "blocker-1"),
      createFinding("WORTH_A_LOOK", "look-1"),
      createFinding("NIT", "nit-1"),
    ];

    const result = applyFindingPolicy(findings);

    expect(result.findings).toHaveLength(3);
    expect(result.omittedWorthALook).toBe(0);
    expect(result.omittedNits).toBe(0);
  });

  it("returns empty results for empty input", () => {
    const result = applyFindingPolicy([]);

    expect(result.findings).toHaveLength(0);
    expect(result.totalFindings).toBe(0);
    expect(result.retainedFindings).toBe(0);
  });
});
