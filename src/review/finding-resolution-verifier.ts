import type { ReviewFinding } from "../validation/review-result.js";

export type ResolutionDecision =
  | "CONFIRMED_FIXED"
  | "STILL_PRESENT"
  | "UNVERIFIED";

export interface ResolutionEvidence {
  findingId: string;
  decision: ResolutionDecision;
  evidence: string;
  verifiedCommitSha: string;
}

export interface FindingResolutionResult {
  finding: ReviewFinding;
  decision: ResolutionDecision;
  evidence: string;
  verifiedCommitSha: string;
}

export class FindingResolutionVerifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingResolutionVerifierError";
  }
}

/**
 * Applies non-resolving verification outcomes to a previously reported finding.
 *
 * This implementation deliberately refuses CONFIRMED_FIXED because it does
 * not independently inspect source code or prove that a fix is correct. A real
 * evidence-backed verifier must be implemented before automatic resolution is enabled.
 */
export function verifyFindingResolution(
  finding: ReviewFinding,
  resolution: ResolutionEvidence,
  expectedHeadSha: string,
): FindingResolutionResult {
  if (!expectedHeadSha.trim()) {
    throw new FindingResolutionVerifierError(
      "Expected commit SHA is required.",
    );
  }

  if (resolution.findingId !== finding.id) {
    throw new FindingResolutionVerifierError(
      "Resolution evidence references a different finding.",
    );
  }

  if (resolution.verifiedCommitSha !== expectedHeadSha) {
    throw new FindingResolutionVerifierError(
      "Resolution evidence does not match the current commit.",
    );
  }

  if (!resolution.evidence.trim()) {
    throw new FindingResolutionVerifierError(
      "Resolution evidence must not be empty.",
    );
  }

  if (resolution.decision === "CONFIRMED_FIXED") {
    throw new FindingResolutionVerifierError(
      "Automatic resolution is disabled until source-code verification is implemented.",
    );
  }

  const updatedFinding: ReviewFinding = {
    ...finding,
    status: "open",
  };

  return {
    finding: updatedFinding,
    decision: resolution.decision,
    evidence: resolution.evidence,
    verifiedCommitSha: resolution.verifiedCommitSha,
  };
}
