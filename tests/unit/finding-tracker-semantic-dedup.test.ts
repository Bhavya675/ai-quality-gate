import { describe, expect, it } from "vitest";

import { trackFindings } from "../../src/review/finding-tracker.js";

import { generateFindingId } from "../../src/review/finding-identity.js";

import type { ReviewFinding } from "../../src/validation/review-result.js";

const duplicateTitles = [
  "Hardcoded true return value in isAdmin bypasses authorization checks",
  "Hardcoded authorization bypass in isAdmin function",
  "Hardcoded true in isAdmin function bypasses access control",
  "isAdmin function unconditionally returns true",
  "Hardcoded admin validation allows unauthorized access",
  "Hardcoded true in isAdmin function causes authorization bypass",
  "Unconditional true return in isAdmin allows complete authorization bypass",
];

function createFinding(
  id: string,
  title: string,
  line = 1,
  file = "src/examples/order-access-control.ts",
): ReviewFinding {
  const finding: ReviewFinding = {
    id,
    severity: "BLOCKER",
    category: "security",
    file,
    line,
    title,
    description: "Every user can execute privileged administrative actions.",
    impact: "Unauthorized administrative access.",
    suggested_fix: "Implement actual administrator permission verification.",
    evidence: "The isAdmin function unconditionally returns true.",
    occurrence: "new",
    status: "open",
  };

  finding.id = generateFindingId(finding);

  return finding;
}

describe("FindingTracker semantic deduplication", () => {
  it("consolidates previously stored duplicate findings", () => {
    const previousFindings = duplicateTitles.map((title, index) =>
      createFinding(`previous-${index}`, title, index % 2 === 0 ? 1 : 2),
    );

    const currentFinding = createFinding(
      "current-ai-finding",
      duplicateTitles[0],
      1,
    );

    const result = trackFindings(previousFindings, [currentFinding]);

    expect(result.currentFindings).toHaveLength(1);
    expect(result.previouslyReportedCount).toBe(1);
    expect(result.newFindingCount).toBe(0);
    expect(result.unverifiedPreviousFindings).toHaveLength(0);

    expect(result.currentFindings[0].occurrence).toBe("previously_reported");
  });

  it("retains the historical finding ID when the AI changes its title", () => {
    const previousFinding = createFinding(
      "previous",
      "Hardcoded authorization bypass in isAdmin function",
    );

    const currentFinding = createFinding(
      "current",
      "isAdmin function unconditionally returns true",
    );

    const result = trackFindings([previousFinding], [currentFinding]);

    expect(result.currentFindings[0].id).toBe(previousFinding.id);
    expect(result.currentFindings[0].occurrence).toBe("previously_reported");
  });

  it("does not merge different vulnerabilities in the same file", () => {
    const previousFinding = createFinding(
      "authorization",
      "Hardcoded authorization bypass in isAdmin",
      10,
    );

    const currentFinding = createFinding(
      "sql",
      "Missing SQL parameterization in queryUsers",
      11,
    );

    // Give the SQL finding evidence specific to SQL injection.
    currentFinding.description =
      "The queryUsers function concatenates untrusted input into SQL.";

    currentFinding.impact =
      "An attacker may manipulate the SQL query and access unauthorized records.";

    currentFinding.suggested_fix =
      "Use parameterized SQL queries and bind user-supplied values.";

    currentFinding.evidence =
      "queryUsers constructs SQL by concatenating the supplied search value.";

    const result = trackFindings([previousFinding], [currentFinding]);

    expect(result.currentFindings).toHaveLength(1);
    expect(result.newFindingCount).toBe(1);
    expect(result.previouslyReportedCount).toBe(0);

    expect(result.unverifiedPreviousFindings).toHaveLength(1);

    expect(result.unverifiedPreviousFindings[0].id).toBe(previousFinding.id);
  });

  it("keeps an unmatched previous finding open", () => {
    const previousFinding = createFinding(
      "previous",
      "Missing authorization validation",
      42,
    );

    const currentFinding = createFinding(
      "current",
      "Missing SQL parameterization in queryUsers",
      100,
    );

    const result = trackFindings([previousFinding], [currentFinding]);

    expect(result.unverifiedPreviousFindings).toHaveLength(1);
    expect(result.unverifiedPreviousFindings[0].status).toBe("open");
  });

  it("resolves only unmatched findings belonging to deleted files", () => {
    const deletedFileFinding = createFinding(
      "deleted",
      "Missing authorization validation",
      10,
      "src/old-service.ts",
    );

    const retainedFileFinding = createFinding(
      "retained",
      "Missing input validation",
      20,
      "src/current-service.ts",
    );

    const result = trackFindings(
      [deletedFileFinding, retainedFileFinding],
      [],
      ["src/old-service.ts"],
    );

    expect(result.resolvedByDeletedFileFindings).toHaveLength(1);

    expect(result.resolvedByDeletedFileFindings[0]).toMatchObject({
      id: deletedFileFinding.id,
      status: "resolved",
    });

    expect(result.unverifiedPreviousFindings).toHaveLength(1);

    expect(result.unverifiedPreviousFindings[0]).toMatchObject({
      id: retainedFileFinding.id,
      status: "open",
    });
  });

  it("reopens a previously resolved finding when it is reported again", () => {
    const previousFinding = createFinding(
      "previous",
      "Hardcoded authorization bypass in isAdmin",
    );

    previousFinding.status = "resolved";

    const currentFinding = createFinding(
      "current",
      "Hardcoded true return value in isAdmin bypasses authorization checks",
    );

    const result = trackFindings([previousFinding], [currentFinding]);

    expect(result.currentFindings).toHaveLength(1);
    expect(result.currentFindings[0].status).toBe("open");
    expect(result.currentFindings[0].id).toBe(previousFinding.id);
    expect(result.currentFindings[0].occurrence).toBe("previously_reported");
  });
});
