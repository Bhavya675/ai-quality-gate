import { AiGatewayError, type AiReviewRequest } from "../gateway/ai-gateway.js";
import type { ReviewFinding } from "../validation/review-result.js";
import type { ResolutionEvidence } from "./finding-resolution-verifier.js";
import type { ReviewService, CompletedReview } from "./review-service.js";
import type { ReviewState, ReviewStateKey } from "../storage/review-state.js";
import {
  ReviewStateStoreError,
  type ReviewStateStore,
} from "../storage/review-state-store.js";

export interface ReviewStateCoordinatorOptions {
  policyVersion: string;
  guidelinesSha: string;
}

export type BeforePersistReview = (
  completedReview: CompletedReview,
) => Promise<void>;

export interface CoordinatedReview {
  completedReview: CompletedReview;
  previousState: ReviewState | null;
  persisted: boolean;
}

export class ReviewStateCoordinatorError extends Error {
  constructor(
    public readonly code:
      | "REVIEW_FAILED"
      | "STATE_LOAD_FAILED"
      | "STATE_SAVE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "ReviewStateCoordinatorError";
  }
}

export class ReviewStateCoordinator {
  constructor(
    private readonly reviewService: Pick<ReviewService, "review">,
    private readonly stateStore: ReviewStateStore,
    private readonly options: ReviewStateCoordinatorOptions,
  ) {
    if (!options.policyVersion.trim()) {
      throw new Error("Policy version is required.");
    }

    if (!options.guidelinesSha.trim()) {
      throw new Error("Guidelines SHA is required.");
    }
  }

  async review(
    request: AiReviewRequest,
    resolutionEvidence: ResolutionEvidence[] = [],
    beforePersist?: BeforePersistReview,
    deletedFilePaths: string[] = [],
  ): Promise<CoordinatedReview> {
    const key: ReviewStateKey = {
      repository: request.repository,
      pullRequestNumber: request.pullRequestNumber,
    };

    let previousState: ReviewState | null;

    try {
      previousState = await this.stateStore.load(key);
    } catch {
      throw new ReviewStateCoordinatorError(
        "STATE_LOAD_FAILED",
        "Unable to load previous review state.",
      );
    }

    const previousFindings: ReviewFinding[] = previousState?.findings ?? [];

    let completedReview: CompletedReview;

    try {
      completedReview = await this.reviewService.review(
        request,
        previousFindings,
        resolutionEvidence,
        deletedFilePaths,
      );
    } catch (error) {
      let diagnosticMessage: string;

      if (error instanceof AiGatewayError) {
        diagnosticMessage = `AI Gateway error [${error.code}]: ${error.message}`;
      } else if (error instanceof Error) {
        diagnosticMessage = `${error.name}: ${error.message}`;
      } else {
        diagnosticMessage = "Unknown review execution error.";
      }

      console.error(`[ReviewStateCoordinator] ${diagnosticMessage}`);

      throw new ReviewStateCoordinatorError(
        "REVIEW_FAILED",
        "Review execution failed.",
      );
    }

    // Always verify freshness before returning or persisting the result.
    // An incomplete review must not be treated as a successful review.
    if (beforePersist) {
      await beforePersist(completedReview);
    }

    if (!completedReview.review.review_complete) {
      return {
        completedReview,
        previousState,
        persisted: false,
      };
    }

    const nextState: ReviewState = {
      schemaVersion: 1,
      repository: request.repository,
      pullRequestNumber: request.pullRequestNumber,
      baseSha: request.baseSha,
      headSha: request.headSha,
      policyVersion: this.options.policyVersion,
      guidelinesSha: this.options.guidelinesSha,
      verdict: completedReview.verdict.verdict,
      findings: completedReview.review.findings,
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.stateStore.save(nextState);
    } catch {
      throw new ReviewStateCoordinatorError(
        "STATE_SAVE_FAILED",
        "Unable to persist completed review state.",
      );
    }

    return {
      completedReview,
      previousState,
      persisted: true,
    };
  }
}
