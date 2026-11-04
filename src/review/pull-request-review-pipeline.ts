import {
  parsePullRequestEvent,
  PullRequestEventError,
} from "../github/pull-request-event.js";
import {
  PullRequestReviewGuard,
  assertHeadShaCurrent,
} from "../github/pull-request-review-guard.js";
import type {
  PullRequestService,
  PullRequestContext,
} from "../github/pull-request-service.js";
import type {
  PullRequestSourceService,
  SourceRetrievalResult,
} from "../github/pull-request-source-service.js";
import type { ReviewPolicyEngine } from "./review-policy-engine.js";
import {
  ReviewContextBuilder,
  type BuiltReviewContext,
} from "./review-context-builder.js";
import type { ReviewFinding } from "../validation/review-result.js";
import type { ResolutionEvidence } from "./finding-resolution-verifier.js";
import {
  ReviewStateCoordinatorError,
  type ReviewStateCoordinator,
  type CoordinatedReview,
} from "./review-state-coordinator.js";

export interface PullRequestReviewPipelineDependencies {
  pullRequestService: Pick<PullRequestService, "getReviewContext">;
  sourceService: Pick<PullRequestSourceService, "retrieve">;
  policyEngine: Pick<ReviewPolicyEngine, "evaluate">;
  contextBuilder: Pick<ReviewContextBuilder, "build">;
  reviewStateCoordinator: Pick<ReviewStateCoordinator, "review">;
  reviewGuard: Pick<PullRequestReviewGuard, "runExclusive">;
  getLatestHeadSha: (
    owner: string,
    repository: string,
    pullRequestNumber: number,
  ) => Promise<string>;
  guidelines: string;
  policyVersion: string;
}

export type PullRequestReviewPipelineResult =
  | {
      accepted: false;
      reason: string;
    }
  | {
      accepted: true;
      pullRequest: PullRequestContext;
      context: BuiltReviewContext;
      source: SourceRetrievalResult;
      coordinatedReview: CoordinatedReview;
      latestHeadSha: string;
    };

export class PullRequestReviewPipelineError extends Error {
  constructor(
    public readonly code:
      | "INVALID_EVENT"
      | "PR_CONTEXT_FAILED"
      | "SOURCE_RETRIEVAL_FAILED"
      | "CONTEXT_BUILD_FAILED"
      | "AI_REVIEW_FAILED"
      | "REVIEW_STATE_FAILED"
      | "LATEST_SHA_CHECK_FAILED"
      | "STALE_REVIEW",
    message: string,
  ) {
    super(message);
    this.name = "PullRequestReviewPipelineError";
  }
}

export class PullRequestReviewPipeline {
  constructor(
    private readonly dependencies: PullRequestReviewPipelineDependencies,
  ) {}

  async execute(
    payload: unknown,
    resolutionEvidence: ResolutionEvidence[] = [],
  ): Promise<PullRequestReviewPipelineResult> {
    let parsedEvent;

    try {
      parsedEvent = parsePullRequestEvent(payload);
    } catch (error) {
      if (error instanceof PullRequestEventError) {
        throw new PullRequestReviewPipelineError(
          "INVALID_EVENT",
          error.message,
        );
      }

      throw error;
    }

    if (!parsedEvent.accepted) {
      return {
        accepted: false,
        reason: parsedEvent.reason,
      };
    }

    const event = parsedEvent.event;

    return this.dependencies.reviewGuard.runExclusive(
      event.owner,
      event.repository,
      event.pullRequestNumber,
      async () => this.executeReview(event, resolutionEvidence),
    );
  }

  private async executeReview(
    event: {
      owner: string;
      repository: string;
      pullRequestNumber: number;
    },
    resolutionEvidence: ResolutionEvidence[],
  ): Promise<PullRequestReviewPipelineResult> {
    let pullRequest: PullRequestContext;

    try {
      pullRequest =
        await this.dependencies.pullRequestService.getReviewContext(event);
    } catch {
      throw new PullRequestReviewPipelineError(
        "PR_CONTEXT_FAILED",
        "Unable to retrieve the pull request review context.",
      );
    }

    const policy = this.dependencies.policyEngine.evaluate(pullRequest.files);

    let source: SourceRetrievalResult;

    try {
      const eligibleFiles = pullRequest.files.filter((file) =>
        policy.eligibleFiles.some(
          (eligible) => eligible.filename === file.filename,
        ),
      );

      source = await this.dependencies.sourceService.retrieve(
        event.owner,
        event.repository,
        pullRequest.headSha,
        eligibleFiles,
      );
    } catch {
      throw new PullRequestReviewPipelineError(
        "SOURCE_RETRIEVAL_FAILED",
        "Unable to retrieve the policy-approved source files.",
      );
    }

    let context: BuiltReviewContext;

    try {
      context = this.dependencies.contextBuilder.build({
        pullRequest,
        source,
        policy,
        guidelines: this.dependencies.guidelines,
        policyVersion: this.dependencies.policyVersion,
      });
    } catch {
      throw new PullRequestReviewPipelineError(
        "CONTEXT_BUILD_FAILED",
        "Unable to build a valid AI review context.",
      );
    }

    const request = {
      requestId: `${event.owner}/${event.repository}#${event.pullRequestNumber}:${pullRequest.headSha}`,
      repository: `${event.owner}/${event.repository}`,
      pullRequestNumber: event.pullRequestNumber,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      systemPrompt: context.systemPrompt,
      userPrompt: context.userPrompt,
      maxTokens: 8192,
    };

    let latestHeadSha: string | undefined;

    let coordinatedReview: CoordinatedReview;

    try {
      coordinatedReview = await this.dependencies.reviewStateCoordinator.review(
        request,
        resolutionEvidence,
        async () => {
          try {
            latestHeadSha = await this.dependencies.getLatestHeadSha(
              event.owner,
              event.repository,
              event.pullRequestNumber,
            );
          } catch {
            throw new PullRequestReviewPipelineError(
              "LATEST_SHA_CHECK_FAILED",
              "Unable to verify the latest pull request commit.",
            );
          }

          try {
            assertHeadShaCurrent(pullRequest.headSha, latestHeadSha);
          } catch {
            throw new PullRequestReviewPipelineError(
              "STALE_REVIEW",
              "The pull request changed during AI review. The result must not be published.",
            );
          }
        },
      );
    } catch (error) {
      if (error instanceof PullRequestReviewPipelineError) {
        throw error;
      }

      if (
        error instanceof ReviewStateCoordinatorError &&
        error.code !== "REVIEW_FAILED"
      ) {
        throw new PullRequestReviewPipelineError(
          "REVIEW_STATE_FAILED",
          "Unable to safely load or persist the previous review state.",
        );
      }

      throw new PullRequestReviewPipelineError(
        "AI_REVIEW_FAILED",
        "The AI review could not be completed successfully.",
      );
    }

    if (!latestHeadSha) {
      throw new PullRequestReviewPipelineError(
        "LATEST_SHA_CHECK_FAILED",
        "The latest pull request commit was not verified.",
      );
    }

    return {
      accepted: true,
      pullRequest,
      context,
      source,
      coordinatedReview,
      latestHeadSha,
    };
  }
}
