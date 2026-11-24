import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { env } from "./config/env.js";
import { createGitHubClient } from "./github/github-client.js";
import { PullRequestReviewGuard } from "./github/pull-request-review-guard.js";
import { PullRequestService } from "./github/pull-request-service.js";
import { PullRequestSourceService } from "./github/pull-request-source-service.js";
import { GitHubReviewStateCommentStore } from "./github/review-state-comment-store.js";
import { ReviewContextBuilder } from "./review/review-context-builder.js";
import { ReviewPolicyEngine } from "./review/review-policy-engine.js";
import { PullRequestReviewPipeline } from "./review/pull-request-review-pipeline.js";
import { ReviewStateCoordinator } from "./review/review-state-coordinator.js";
import { ReviewService } from "./review/review-service.js";
import { AiGateway } from "./gateway/ai-gateway.js";
import { GeminiProvider } from "./gateway/providers/gemini-provider.js";
import { AiFindingResolutionChecker } from "./review/ai-finding-resolution-checker.js";
import { InlineReviewCommentPublisher } from "./github/inline-review-comments.js";
import {
  extractStateBlock,
  withStateBlock,
} from "./github/review-state-comment-store.js";
import {
  RESULT_MARKER,
  renderResultComment,
} from "./github/result-comment-renderer.js";

async function publishResultComment(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repository: string,
  pullRequestNumber: number,
  body: string,
): Promise<void> {
  let existing: { id: number; body?: string | null } | undefined;

  for (let page = 1; page <= 20 && !existing; page++) {
    const response = await octokit.rest.issues.listComments({
      owner,
      repo: repository,
      issue_number: pullRequestNumber,
      per_page: 100,
      page,
    });

    existing = response.data.find((comment) =>
      comment.body?.includes(RESULT_MARKER),
    );

    if (response.data.length < 100) {
      break;
    }
  }

  if (existing) {
    // The review state lives in a hidden block of this same comment: keep it.
    await octokit.rest.issues.updateComment({
      owner,
      repo: repository,
      comment_id: existing.id,
      body: withStateBlock(body, extractStateBlock(existing.body)),
    });
    return;
  }

  await octokit.rest.issues.createComment({
    owner,
    repo: repository,
    issue_number: pullRequestNumber,
    body,
  });
}

async function writeStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, `${markdown}\n`, "utf8");
  }
}

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error(
      "GITHUB_EVENT_PATH is not set. Run this command from a GitHub Actions pull_request event.",
    );
  }

  const eventPayload = JSON.parse(await readFile(eventPath, "utf8")) as unknown;
  const repositoryFromEnvironment = process.env.GITHUB_REPOSITORY;
  if (!repositoryFromEnvironment) {
    throw new Error("GITHUB_REPOSITORY is not set.");
  }

  const [ownerFromEnvironment, repositoryFromEnvironmentName] =
    repositoryFromEnvironment.split("/");
  if (!ownerFromEnvironment || !repositoryFromEnvironmentName) {
    throw new Error("GITHUB_REPOSITORY must use owner/repository format.");
  }

  const guidelinesPath = resolve(process.cwd(), "docs/review-guidelines.md");
  const guidelines = await readFile(guidelinesPath, "utf8");
  const actualGuidelinesSha = createHash("sha256")
    .update(guidelines, "utf8")
    .digest("hex");
  if (actualGuidelinesSha !== env.REVIEW_GUIDELINES_SHA) {
    throw new Error(
      "REVIEW_GUIDELINES_SHA does not match docs/review-guidelines.md. Update the configured hash.",
    );
  }

  const octokit = createGitHubClient(env.GITHUB_TOKEN);
  const pullRequestService = new PullRequestService(octokit);
  const sourceService = new PullRequestSourceService(octokit);
  const gateway = new AiGateway(
    new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL),
  );
  const resolutionChecker = new AiFindingResolutionChecker(
    gateway,
    async (repository, headSha, paths) => {
      const [owner, repo] = repository.split("/");
      const files = new Map<string, string>();

      for (const path of paths) {
        try {
          const result = await sourceService.retrieve(owner, repo, headSha, [
            {
              filename: path,
              status: "modified",
              additions: 0,
              deletions: 0,
              changes: 0,
            },
          ]);

          if (result.files[0]) {
            files.set(path, result.files[0].content);
          }
        } catch {
          // Unreadable file: its finding simply stays open.
        }
      }

      return files;
    },
  );
  const reviewService = new ReviewService(gateway, resolutionChecker);
  const stateStore = new GitHubReviewStateCommentStore(
    octokit,
    env.REVIEW_STATE_SIGNING_SECRET,
  );
  const stateCoordinator = new ReviewStateCoordinator(
    reviewService,
    stateStore,
    {
      policyVersion: env.REVIEW_POLICY_VERSION,
      guidelinesSha: actualGuidelinesSha,
    },
  );

  const pipeline = new PullRequestReviewPipeline({
    pullRequestService,
    sourceService,
    policyEngine: new ReviewPolicyEngine(),
    contextBuilder: new ReviewContextBuilder(),
    reviewStateCoordinator: stateCoordinator,
    reviewGuard: new PullRequestReviewGuard(),
    getLatestHeadSha: async (owner, repository, pullRequestNumber) =>
      pullRequestService.getLatestHeadSha({
        owner,
        repository,
        pullRequestNumber,
      }),
    guidelines,
    policyVersion: env.REVIEW_POLICY_VERSION,
  });

  const result = await pipeline.execute(eventPayload);
  if (!result.accepted) {
    console.log(`Pull request event skipped: ${result.reason}`);
    return;
  }

  const completed = result.coordinatedReview.completedReview;
  const { owner, repository, pullRequestNumber, headSha, files } =
    result.pullRequest;

  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const runId = process.env.GITHUB_RUN_ID;
  const renderComment = (inlineCommentUrls?: ReadonlyMap<string, string>) =>
    renderResultComment({
      verdict: completed.verdict.verdict,
      summary: completed.verdict.summary,
      reviewComplete: completed.review.review_complete,
      headSha,
      findings: completed.review.findings,
      sensitiveCategories: completed.review.sensitive_categories,
      serverUrl,
      owner,
      repository,
      workflowRunUrl: runId
        ? `${serverUrl}/${owner}/${repository}/actions/runs/${runId}`
        : undefined,
      inlineCommentUrls,
    });

  // 1) Summary first, so it sits above the inline review threads.
  await publishResultComment(
    octokit,
    owner,
    repository,
    pullRequestNumber,
    renderComment(),
  );

  // 2) Inline comments are best-effort: they must never change the gate result.
  let inlineCommentUrls = new Map<string, string>();
  try {
    inlineCommentUrls = await new InlineReviewCommentPublisher(
      octokit as never,
    ).sync({
      owner,
      repository,
      pullRequestNumber,
      headSha,
      files,
      findings: completed.review.findings,
    });
  } catch (error) {
    console.warn(
      "Inline review comments failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }

  // 3) Re-publish the summary so each file link opens its inline comment.
  const comment = renderComment(inlineCommentUrls);
  if (inlineCommentUrls.size > 0) {
    await publishResultComment(
      octokit,
      owner,
      repository,
      pullRequestNumber,
      comment,
    );
  }
  await writeStepSummary(comment);

  console.log(`AI Quality Gate verdict: ${completed.verdict.verdict}`);
  console.log(`Commit reviewed: ${result.pullRequest.headSha}`);
  console.log(`Blockers: ${completed.verdict.blockerCount}`);
  console.log(`Worth a look: ${completed.verdict.worthALookCount}`);
  console.log(`Nits: ${completed.verdict.nitCount}`);
  console.log(`Review state persisted: ${result.coordinatedReview.persisted}`);

  if (completed.verdict.verdict === "FAIL") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "Unexpected review execution error.";
  console.error(`AI Quality Gate failed: ${message}`);
  process.exitCode = 1;
});
