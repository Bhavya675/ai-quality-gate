import type { ReviewFinding } from "../validation/review-result.js";

export interface FindingTrackerResult {
  currentFindings: ReviewFinding[];
  newFindingCount: number;
  previouslyReportedCount: number;
  unverifiedPreviousFindings: ReviewFinding[];
  resolvedByDeletedFileFindings: ReviewFinding[];
}

function normalizeRepositoryPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "");
}

export function trackFindings(
  previousFindings: ReviewFinding[],
  currentFindings: ReviewFinding[],
  deletedFilePaths: string[] = [],
): FindingTrackerResult {
  const previousById = new Map(
    previousFindings.map((finding) => [finding.id, finding]),
  );

  const currentIds = new Set(currentFindings.map((finding) => finding.id));

  const deletedPaths = new Set(deletedFilePaths.map(normalizeRepositoryPath));

  const trackedFindings = currentFindings.map((finding) => {
    const previousFinding = previousById.get(finding.id);

    return {
      ...finding,
      occurrence: previousFinding
        ? ("previously_reported" as const)
        : ("new" as const),
    };
  });

  const unmatchedPreviousFindings = previousFindings.filter(
    (finding) => !currentIds.has(finding.id) && finding.status === "open",
  );

  const resolvedByDeletedFileFindings = unmatchedPreviousFindings
    .filter((finding) =>
      deletedPaths.has(normalizeRepositoryPath(finding.file)),
    )
    .map((finding) => ({
      ...finding,
      status: "resolved" as const,
    }));

  const unverifiedPreviousFindings = unmatchedPreviousFindings.filter(
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
