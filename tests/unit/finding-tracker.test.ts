import { describe, expect, it } from "vitest";
import { trackFindings } from "../../src/review/finding-tracker.js";
import type { ReviewFinding } from "../../src/validation/review-result.js";

function createFinding(
  id: string,
  status: "open" | "resolved" = "open",
): ReviewFinding {
  return {
    id,
    severity: "BLOCKER",
    category: "correctness",
    file: "src/example.ts",
    line: 10,
    title: `Finding ${id}`,
    description: "Example description.",
    impact: "Example impact.",
    suggested_fix: "Example fix.",
    evidence: "Example evidence.",
    occurrence: "new",
    status,
  };
}

describe("FindingTracker", () => {
  it("identifies a finding that was reported previously", () => {
    const previous = [createFinding("finding-001")];
    const current = [createFinding("finding-001")];

    const result = trackFindings(previous, current);

    expect(result.currentFindings[0].occurrence).toBe("previously_reported");
    expect(result.previouslyReportedCount).toBe(1);
    expect(result.newFindingCount).toBe(0);
  });

  it("identifies newly introduced findings", () => {
    const previous = [createFinding("finding-001")];
    const current = [createFinding("finding-002")];

    const result = trackFindings(previous, current);

    expect(result.currentFindings[0].occurrence).toBe("new");
    expect(result.newFindingCount).toBe(1);
    expect(result.previouslyReportedCount).toBe(0);
  });

  it("identifies both new and previously reported findings", () => {
    const previous = [createFinding("finding-001")];
    const current = [
      createFinding("finding-001"),
      createFinding("finding-002"),
    ];

    const result = trackFindings(previous, current);

    expect(result.newFindingCount).toBe(1);
    expect(result.previouslyReportedCount).toBe(1);
  });

  it("does not mark a missing previous finding as resolved", () => {
    const previous = [createFinding("finding-001")];

    const result = trackFindings(previous, []);

    expect(result.unverifiedPreviousFindings).toHaveLength(1);
    expect(result.unverifiedPreviousFindings[0].status).toBe("open");
  });

  it("does not treat an already resolved previous finding as unverified", () => {
    const previous = [createFinding("finding-001", "resolved")];

    const result = trackFindings(previous, []);

    expect(result.unverifiedPreviousFindings).toHaveLength(0);
  });

  it("handles an empty previous review", () => {
    const current = [createFinding("finding-001")];

    const result = trackFindings([], current);

    expect(result.newFindingCount).toBe(1);
    expect(result.previouslyReportedCount).toBe(0);
  });

  it("handles empty previous and current reviews", () => {
    const result = trackFindings([], []);

    expect(result.currentFindings).toHaveLength(0);
    expect(result.newFindingCount).toBe(0);
    expect(result.previouslyReportedCount).toBe(0);
    expect(result.unverifiedPreviousFindings).toHaveLength(0);
  });

  it("automatically resolves previous findings when their file is deleted", () => {
    const deletedFinding = createFinding("finding-deleted");
    deletedFinding.file = "src/old-service.ts";

    const retainedFinding = createFinding("finding-retained");
    retainedFinding.file = "src/current-service.ts";

    const result = trackFindings(
      [deletedFinding, retainedFinding],
      [],
      ["src/old-service.ts"],
    );

    expect(result.resolvedByDeletedFileFindings).toHaveLength(1);
    expect(result.resolvedByDeletedFileFindings[0]).toMatchObject({
      id: "finding-deleted",
      status: "resolved",
    });

    expect(result.unverifiedPreviousFindings).toHaveLength(1);
    expect(result.unverifiedPreviousFindings[0]).toMatchObject({
      id: "finding-retained",
      status: "open",
    });
  });

  it("matches deleted paths after normalizing Windows separators", () => {
    const previousFinding = createFinding("finding-deleted");
    previousFinding.file = "src\\old-service.ts";

    const result = trackFindings([previousFinding], [], ["src/old-service.ts"]);

    expect(result.resolvedByDeletedFileFindings).toHaveLength(1);
    expect(result.unverifiedPreviousFindings).toHaveLength(0);
  });
});
