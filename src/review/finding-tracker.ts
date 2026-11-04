import type { ReviewFinding } from "../validation/review-result.js";

export interface FindingTrackerResult {
  currentFindings: ReviewFinding[];
  newFindingCount: number;
  previouslyReportedCount: number;
  unverifiedPreviousFindings: ReviewFinding[];
}

export function trackFindings(
  previousFindings: ReviewFinding[],
  currentFindings: ReviewFinding[],
): FindingTrackerResult {
  const previousById = new Map(
    previousFindings.map((finding) => [finding.id, finding]),
  );

  const currentIds = new Set(currentFindings.map((finding) => finding.id));

  const trackedFindings = currentFindings.map((finding) => {
    const previousFinding = previousById.get(finding.id);

    return {
      ...finding,
      occurrence: previousFinding
        ? ("previously_reported" as const)
        : ("new" as const),
    };
  });

  const unverifiedPreviousFindings = previousFindings.filter(
    (finding) => !currentIds.has(finding.id) && finding.status === "open",
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
  };
}
