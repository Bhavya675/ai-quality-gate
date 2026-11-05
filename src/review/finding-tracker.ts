import type { ReviewFinding } from "../validation/review-result.js";
import { areEquivalentFindings } from "./finding-identity.js";

export interface FindingTrackerResult {
  currentFindings: ReviewFinding[];
  newFindingCount: number;
  previouslyReportedCount: number;
  unverifiedPreviousFindings: ReviewFinding[];
  resolvedByDeletedFileFindings: ReviewFinding[];
}

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
  NIT: 1,
  WORTH_A_LOOK: 2,
  BLOCKER: 3,
};

function normalizeRepositoryPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "");
}

function consolidatePreviousFindings(
  findings: ReviewFinding[],
): ReviewFinding[] {
  const unique: ReviewFinding[] = [];

  for (const finding of findings) {
    const duplicateIndex = unique.findIndex((existing) =>
      areEquivalentFindings(existing, finding),
    );

    if (duplicateIndex === -1) {
      unique.push({ ...finding });
      continue;
    }

    const existing = unique[duplicateIndex];

    const preferred =
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]
        ? finding
        : existing;

    unique[duplicateIndex] = {
      ...preferred,

      // Preserve the first historical server-generated identity.
      id: existing.id,

      // An open historical duplicate must never be hidden by a resolved one.
      status:
        existing.status === "open" || finding.status === "open"
          ? "open"
          : "resolved",
    };
  }

  return unique;
}

export function trackFindings(
  previousFindings: ReviewFinding[],
  currentFindings: ReviewFinding[],
  deletedFilePaths: string[] = [],
): FindingTrackerResult {
  const normalizedPreviousFindings =
    consolidatePreviousFindings(previousFindings);

  const unmatchedPrevious = [...normalizedPreviousFindings];

  const matchedPreviousIds = new Set<string>();

  const trackedFindings = currentFindings.map((finding) => {
    const previousFinding = unmatchedPrevious.find(
      (previous) =>
        !matchedPreviousIds.has(previous.id) &&
        areEquivalentFindings(previous, finding),
    );

    if (!previousFinding) {
      return {
        ...finding,
        occurrence: "new" as const,
      };
    }

    matchedPreviousIds.add(previousFinding.id);

    return {
      ...finding,

      // Keep historical identity across AI title changes.
      id: previousFinding.id,

      // Do not allow the AI to downgrade a historical severity.
      severity:
        SEVERITY_RANK[previousFinding.severity] >
        SEVERITY_RANK[finding.severity]
          ? previousFinding.severity
          : finding.severity,

      occurrence: "previously_reported" as const,
      status: "open" as const,
    };
  });

  const unmatchedOpenPreviousFindings = unmatchedPrevious.filter(
    (finding) =>
      !matchedPreviousIds.has(finding.id) && finding.status === "open",
  );

  const deletedPaths = new Set(deletedFilePaths.map(normalizeRepositoryPath));

  const resolvedByDeletedFileFindings = unmatchedOpenPreviousFindings
    .filter((finding) =>
      deletedPaths.has(normalizeRepositoryPath(finding.file)),
    )
    .map((finding) => ({
      ...finding,
      status: "resolved" as const,
    }));

  const unverifiedPreviousFindings = unmatchedOpenPreviousFindings.filter(
    (finding) => !deletedPaths.has(normalizeRepositoryPath(finding.file)),
  );

  return {
    currentFindings: trackedFindings,

    newFindingCount: trackedFindings.filter(
      (finding) => finding.occurrence === "new",
    ).length,

    previouslyReportedCount: trackedFindings.filter(
      (finding) => finding.occurrence === "previously_reported",
    ).length,

    unverifiedPreviousFindings,
    resolvedByDeletedFileFindings,
  };
}
