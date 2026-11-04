import type { Octokit } from "@octokit/rest";

import { env } from "./config/env.js";

import { AiGateway } from "./gateway/ai-gateway.js";
import { GeminiProvider } from "./gateway/providers/gemini-provider.js";

import { ReviewService } from "./review/review-service.js";
import { ReviewStateCoordinator } from "./review/review-state-coordinator.js";

import { GitHubReviewStateCommentStore } from "./github/review-state-comment-store.js";
import { PullRequestService } from "./github/pull-request-service.js";

export function createAiGateway(): AiGateway {
  const provider = new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL);

  return new AiGateway(provider);
}

export function createReviewService(): ReviewService {
  return new ReviewService(createAiGateway());
}

export interface ReviewCoordinatorConfig {
  signingSecret: string;
  policyVersion: string;
  guidelinesSha: string;
}

/**
 * Creates the GitHub pull request service.
 *
 * The supplied Octokit instance must use an appropriately
 * permission-scoped GitHub authentication token.
 */
export function createPullRequestService(octokit: Octokit): PullRequestService {
  return new PullRequestService(octokit);
}

/**
 * Creates the review coordinator with GitHub-backed state persistence.
 *
 * The signing secret must be supplied securely by the caller.
 */
export function createReviewStateCoordinator(
  octokit: Octokit,
  config: ReviewCoordinatorConfig,
): ReviewStateCoordinator {
  const reviewService = createReviewService();

  const stateStore = new GitHubReviewStateCommentStore(
    octokit,
    config.signingSecret,
  );

  return new ReviewStateCoordinator(reviewService, stateStore, {
    policyVersion: config.policyVersion,
    guidelinesSha: config.guidelinesSha,
  });
}
