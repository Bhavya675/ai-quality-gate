import type {
  ReviewFinding,
  ReviewResult,
  ReviewVerdict,
} from "../validation/review-result.js";

export interface VerdictResult {
  verdict: ReviewVerdict;
  summary: string;
  blockerCount: number;
  worthALookCount: number;
  nitCount: number;
}

const MAX_WORTH_A_LOOK = 5;
const MAX_NITS = 3;

export function calculateVerdict(review: ReviewResult): VerdictResult {
  const openFindings = review.findings.filter(
    (finding) => finding.status === "open",
  );

  const blockers = openFindings.filter(
    (finding) => finding.severity === "BLOCKER",
  );

  const worthALook = openFindings.filter(
    (finding) => finding.severity === "WORTH_A_LOOK",
  );

  const nits = openFindings.filter((finding) => finding.severity === "NIT");

  const verdict: ReviewVerdict =
    !review.review_complete || blockers.length > 0 ? "FAIL" : "PASS";

  return {
    verdict,
    summary: createSummary(
      verdict,
      blockers,
      worthALook,
      nits,
      review.review_complete,
    ),
    blockerCount: blockers.length,
    worthALookCount: worthALook.length,
    nitCount: nits.length,
  };
}

function createSummary(
  verdict: ReviewVerdict,
  blockers: ReviewFinding[],
  worthALook: ReviewFinding[],
  nits: ReviewFinding[],
  reviewComplete: boolean,
): string {
  if (!reviewComplete) {
    return "Review incomplete. Manual investigation is required.";
  }

  if (verdict === "FAIL") {
    return `${blockers.length} blocker(s) identified. Merge must be blocked.`;
  }

  return [
    "No blockers identified.",
    `${Math.min(worthALook.length, MAX_WORTH_A_LOOK)} worth-a-look finding(s).`,
    `${Math.min(nits.length, MAX_NITS)} nit(s).`,
  ].join(" ");
}
