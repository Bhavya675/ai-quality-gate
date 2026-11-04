import type { ReviewFinding } from "../validation/review-result.js";

export interface FindingPolicyResult {
  findings: ReviewFinding[];
  totalFindings: number;
  retainedFindings: number;
  omittedWorthALook: number;
  omittedNits: number;
}

const MAX_WORTH_A_LOOK = 5;
const MAX_NITS = 3;

export function applyFindingPolicy(
  findings: ReviewFinding[],
): FindingPolicyResult {
  const blockers = findings.filter((finding) => finding.severity === "BLOCKER");

  const worthALook = findings.filter(
    (finding) => finding.severity === "WORTH_A_LOOK",
  );

  const nits = findings.filter((finding) => finding.severity === "NIT");

  const retainedWorthALook = worthALook.slice(0, MAX_WORTH_A_LOOK);

  const retainedNits = nits.slice(0, MAX_NITS);

  const retained = [...blockers, ...retainedWorthALook, ...retainedNits];

  return {
    findings: retained,
    totalFindings: findings.length,
    retainedFindings: retained.length,
    omittedWorthALook: worthALook.length - retainedWorthALook.length,
    omittedNits: nits.length - retainedNits.length,
  };
}
