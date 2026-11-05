import type { AiGateway, AiReviewRequest } from "../gateway/ai-gateway.js";

import {
  ReviewResultSchema,
  type ReviewResult,
  type ReviewFinding,
} from "../validation/review-result.js";

import { calculateVerdict, type VerdictResult } from "./verdict-engine.js";

import {
  applyFindingPolicy,
  type FindingPolicyResult,
} from "./finding-policy.js";

import {
  deduplicateFindings,
  type DeduplicationResult,
} from "./finding-identity.js";

import { trackFindings, type FindingTrackerResult } from "./finding-tracker.js";

import {
  verifyFindingResolution,
  type ResolutionEvidence,
  type FindingResolutionResult,
} from "./finding-resolution-verifier.js";

export class ReviewServiceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_JSON"
      | "INVALID_REVIEW_RESULT"
      | "COMMIT_MISMATCH"
      | "INVALID_RESOLUTION",
    message: string,
  ) {
    super(message);
    this.name = "ReviewServiceError";
  }
}

export interface CompletedReview {
  review: ReviewResult;
  verdict: VerdictResult;
  findingPolicy: FindingPolicyResult;
  deduplication: DeduplicationResult;
  tracking: FindingTrackerResult;
  resolutions: FindingResolutionResult[];
}

export class ReviewService {
  constructor(private readonly gateway: AiGateway) {}

  async review(
    request: AiReviewRequest,
    previousFindings: ReviewFinding[] = [],
    resolutionEvidence: ResolutionEvidence[] = [],
    deletedFilePaths: string[] = [],
  ): Promise<CompletedReview> {
    const response = await this.gateway.review(request);

    let parsed: unknown;

    try {
      parsed = JSON.parse(response.content);
    } catch {
      throw new ReviewServiceError(
        "INVALID_JSON",
        "AI provider returned invalid JSON.",
      );
    }

    const validation = ReviewResultSchema.safeParse(parsed);

    if (!validation.success) {
      throw new ReviewServiceError(
        "INVALID_REVIEW_RESULT",
        "AI provider returned a review that does not match the required schema.",
      );
    }

    const review = validation.data;

    if (review.commit_sha !== request.headSha) {
      throw new ReviewServiceError(
        "COMMIT_MISMATCH",
        "AI review result does not match the requested commit.",
      );
    }

    // AI output is never authoritative for finding lifecycle metadata.
    // Every finding returned by the model is treated as open; only the
    // server-side tracker and a future evidence-backed verifier may change it.
    const aiFindings = review.findings.map((finding) => ({
      ...finding,
      status: "open" as const,
      occurrence: "new" as const,
    }));

    // 1. Generate stable IDs and remove duplicate findings.
    const deduplication = deduplicateFindings(aiFindings);

    // 2. Compare current findings with previous findings.
    const tracking = trackFindings(
      previousFindings,
      deduplication.findings,
      deletedFilePaths,
    );

    // 3. Index resolution evidence by finding ID.
    const unverifiedPreviousFindings = tracking.unverifiedPreviousFindings;

    const previousFindingIds = new Set(
      unverifiedPreviousFindings.map((finding) => finding.id),
    );

    const resolutionByFindingId = new Map<string, ResolutionEvidence>();

    for (const evidence of resolutionEvidence) {
      if (!previousFindingIds.has(evidence.findingId)) {
        throw new ReviewServiceError(
          "INVALID_RESOLUTION",
          "Resolution evidence references an unknown previous finding.",
        );
      }

      if (resolutionByFindingId.has(evidence.findingId)) {
        throw new ReviewServiceError(
          "INVALID_RESOLUTION",
          "Duplicate resolution evidence was supplied.",
        );
      }

      resolutionByFindingId.set(evidence.findingId, evidence);
    }

    // 4. Apply resolution decisions to missing previous findings.
    const resolutions: FindingResolutionResult[] = [];

    const processedPreviousFindings = unverifiedPreviousFindings.map(
      (finding) => {
        const evidence = resolutionByFindingId.get(finding.id);

        if (!evidence) {
          return finding;
        }

        try {
          const resolution = verifyFindingResolution(
            finding,
            evidence,
            request.headSha,
          );

          resolutions.push(resolution);

          return resolution.finding;
        } catch {
          throw new ReviewServiceError(
            "INVALID_RESOLUTION",
            "Previous finding resolution could not be verified.",
          );
        }
      },
    );

    // 5. Combine current findings with previous findings.
    const combinedFindings = [
      ...tracking.currentFindings,
      ...tracking.resolvedByDeletedFileFindings,
      ...processedPreviousFindings,
    ];

    // 6. Separate open and resolved findings.
    const openFindings = combinedFindings.filter(
      (finding) => finding.status === "open",
    );

    const resolvedFindings = combinedFindings.filter(
      (finding) => finding.status === "resolved",
    );

    // 7. Apply finding limits.
    const findingPolicy = applyFindingPolicy(openFindings);

    const processedReview: ReviewResult = {
      ...review,
      findings: [...findingPolicy.findings, ...resolvedFindings],
    };

    // 8. Calculate the authoritative verdict.
    const verdict = calculateVerdict(processedReview);

    return {
      review: {
        ...processedReview,
        verdict: verdict.verdict,
        summary: verdict.summary,
      },
      verdict,
      findingPolicy,
      deduplication,
      tracking,
      resolutions,
    };
  }
}
