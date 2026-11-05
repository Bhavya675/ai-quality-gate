import { describe, expect, it, vi } from "vitest";
import {
  PullRequestReviewPipeline,
  type PullRequestReviewPipelineDependencies,
} from "../../src/review/pull-request-review-pipeline.js";
import type { CoordinatedReview } from "../../src/review/review-state-coordinator.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const NEW_HEAD_SHA = "c".repeat(40);

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: {
      name: "ai-quality-gate",
      owner: { login: "Bhavya675" },
    },
    pull_request: {
      number: 12,
      draft: false,
      state: "open",
      merged: false,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
    },
    ...overrides,
  };
}

function createPullRequest() {
  return {
    owner: "Bhavya675",
    repository: "ai-quality-gate",
    pullRequestNumber: 12,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    files: [
      {
        filename: "src/example.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: "@@ -1 +1 @@",
      },
    ],
  };
}

function createSource() {
  const content = "export const value = 42;";
  const sizeBytes = new TextEncoder().encode(content).byteLength;

  return {
    files: [
      {
        path: "src/example.ts",
        status: "modified",
        content,
        sizeBytes,
      },
    ],
    skippedFiles: [],
    totalBytes: sizeBytes,
  };
}

function createPolicy() {
  return {
    eligibleFiles: [{ filename: "src/example.ts", status: "modified" }],
    excludedFiles: [],
    sensitiveCategories: [],
  };
}

function createContext() {
  return {
    systemPrompt: "Review the code safely.",
    userPrompt: "Review this pull request.",
    contextBytes: 100,
    fileCount: 1,
    excludedFileCount: 0,
    sensitiveCategories: [],
    policyVersion: "1.0.0",
    headSha: HEAD_SHA,
  };
}

function createCoordinatedReview(): CoordinatedReview {
  return {
    completedReview: {} as CoordinatedReview["completedReview"],
    previousState: null,
    persisted: true,
  };
}

function createDependencies() {
  const pullRequestService = {
    getReviewContext: vi.fn().mockResolvedValue(createPullRequest()),
  };

  const sourceService = {
    retrieve: vi.fn().mockResolvedValue(createSource()),
  };

  const policyEngine = {
    evaluate: vi.fn().mockReturnValue(createPolicy()),
  };

  const contextBuilder = {
    build: vi.fn().mockReturnValue(createContext()),
  };

  const reviewStateCoordinator = {
    review: vi
      .fn()
      .mockImplementation(
        async (
          _request: unknown,
          _resolutionEvidence: unknown,
          beforePersist?: () => Promise<void>,
        ) => {
          if (beforePersist) {
            await beforePersist();
          }

          return createCoordinatedReview();
        },
      ),
  };

  const reviewGuard = {
    runExclusive: vi.fn(
      async (
        _owner: string,
        _repository: string,
        _pullRequestNumber: number,
        operation: () => Promise<unknown>,
      ) => operation(),
    ),
  };

  const getLatestHeadSha = vi.fn().mockResolvedValue(HEAD_SHA);

  const dependencies = {
    pullRequestService,
    sourceService,
    policyEngine,
    contextBuilder,
    reviewStateCoordinator,
    reviewGuard,
    getLatestHeadSha,
    guidelines: "Check correctness and security.",
    policyVersion: "1.0.0",
  } as unknown as PullRequestReviewPipelineDependencies;

  return {
    dependencies,
    pullRequestService,
    sourceService,
    policyEngine,
    contextBuilder,
    reviewStateCoordinator,
    reviewGuard,
    getLatestHeadSha,
  };
}

describe("PullRequestReviewPipeline", () => {
  it("rejects malformed GitHub event payloads", async () => {
    const mocks = createDependencies();
    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await expect(pipeline.execute(null)).rejects.toMatchObject({
      code: "INVALID_EVENT",
    });

    expect(mocks.reviewGuard.runExclusive).not.toHaveBeenCalled();
  });

  it("ignores unsupported pull request actions", async () => {
    const mocks = createDependencies();
    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    const result = await pipeline.execute(createEvent({ action: "closed" }));

    expect(result).toEqual({
      accepted: false,
      reason: "UNSUPPORTED_ACTION",
    });

    expect(mocks.pullRequestService.getReviewContext).not.toHaveBeenCalled();
  });

  it("ignores draft pull requests", async () => {
    const mocks = createDependencies();
    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    const result = await pipeline.execute(
      createEvent({
        pull_request: {
          ...createEvent().pull_request,
          draft: true,
        },
      }),
    );

    expect(result).toEqual({
      accepted: false,
      reason: "DRAFT_PULL_REQUEST",
    });

    expect(mocks.reviewGuard.runExclusive).not.toHaveBeenCalled();
  });

  it("executes the complete review pipeline successfully", async () => {
    const mocks = createDependencies();
    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    const result = await pipeline.execute(createEvent());

    expect(result.accepted).toBe(true);

    if (!result.accepted) {
      throw new Error("Expected an accepted review.");
    }

    expect(result.pullRequest.headSha).toBe(HEAD_SHA);
    expect(result.context.headSha).toBe(HEAD_SHA);
    expect(result.coordinatedReview).toBeDefined();
    expect(result.coordinatedReview.persisted).toBe(true);
    expect(result.latestHeadSha).toBe(HEAD_SHA);

    expect(mocks.reviewGuard.runExclusive).toHaveBeenCalledWith(
      "Bhavya675",
      "ai-quality-gate",
      12,
      expect.any(Function),
    );

    expect(mocks.pullRequestService.getReviewContext).toHaveBeenCalledWith({
      owner: "Bhavya675",
      repository: "ai-quality-gate",
      pullRequestNumber: 12,
    });
    expect(mocks.policyEngine.evaluate).toHaveBeenCalled();
    expect(mocks.sourceService.retrieve).toHaveBeenCalledWith(
      "Bhavya675",
      "ai-quality-gate",
      HEAD_SHA,
      createPullRequest().files,
    );
    expect(mocks.contextBuilder.build).toHaveBeenCalled();
    expect(mocks.reviewStateCoordinator.review).toHaveBeenCalled();
    expect(mocks.getLatestHeadSha).toHaveBeenCalledWith(
      "Bhavya675",
      "ai-quality-gate",
      12,
    );
  });

  it("evaluates policy before retrieving source files", async () => {
    const executionOrder: string[] = [];
    const mocks = createDependencies();

    mocks.policyEngine.evaluate.mockImplementation(() => {
      executionOrder.push("policy");
      return createPolicy();
    });

    mocks.sourceService.retrieve.mockImplementation(async () => {
      executionOrder.push("source");
      return createSource();
    });

    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await pipeline.execute(createEvent());

    expect(executionOrder).toEqual(["policy", "source"]);
  });

  it("does not retrieve excluded files", async () => {
    const mocks = createDependencies();

    mocks.policyEngine.evaluate.mockReturnValue({
      eligibleFiles: [],
      excludedFiles: [
        {
          filename: "src/example.ts",
          reason: "BINARY_OR_NON_SOURCE_EXTENSION",
        },
      ],
      sensitiveCategories: [],
    });

    mocks.sourceService.retrieve.mockResolvedValue({
      files: [],
      skippedFiles: [],
      totalBytes: 0,
    });

    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await pipeline.execute(createEvent());

    expect(mocks.sourceService.retrieve).toHaveBeenCalledWith(
      "Bhavya675",
      "ai-quality-gate",
      HEAD_SHA,
      [],
    );
  });

  it("stops when source retrieval fails", async () => {
    const mocks = createDependencies();

    mocks.sourceService.retrieve.mockRejectedValue(
      new Error("Source retrieval failure"),
    );

    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await expect(pipeline.execute(createEvent())).rejects.toMatchObject({
      code: "SOURCE_RETRIEVAL_FAILED",
    });

    expect(mocks.reviewStateCoordinator.review).not.toHaveBeenCalled();
    expect(mocks.getLatestHeadSha).not.toHaveBeenCalled();
  });

  it("stops when AI review fails", async () => {
    const mocks = createDependencies();

    mocks.reviewStateCoordinator.review.mockRejectedValue(
      new Error("AI provider failure"),
    );

    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await expect(pipeline.execute(createEvent())).rejects.toMatchObject({
      code: "AI_REVIEW_FAILED",
    });

    expect(mocks.getLatestHeadSha).not.toHaveBeenCalled();
  });

  it("rejects results when the PR head changes during review", async () => {
    const mocks = createDependencies();

    mocks.getLatestHeadSha.mockResolvedValue(NEW_HEAD_SHA);

    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await expect(pipeline.execute(createEvent())).rejects.toMatchObject({
      code: "STALE_REVIEW",
    });
  });

  it("fails when the latest head SHA cannot be retrieved", async () => {
    const mocks = createDependencies();

    mocks.getLatestHeadSha.mockRejectedValue(
      new Error("GitHub API unavailable"),
    );

    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await expect(pipeline.execute(createEvent())).rejects.toMatchObject({
      code: "LATEST_SHA_CHECK_FAILED",
    });
  });

  it("does not call the review coordinator for unsupported events", async () => {
    const mocks = createDependencies();
    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await pipeline.execute(createEvent({ action: "closed" }));

    expect(mocks.reviewStateCoordinator.review).not.toHaveBeenCalled();
  });

  it("passes deleted PR file paths to the review coordinator", async () => {
    const mocks = createDependencies();

    mocks.pullRequestService.getReviewContext.mockResolvedValue({
      ...createPullRequest(),
      files: [
        ...createPullRequest().files,
        {
          filename: "src/old-service.ts",
          status: "removed",
          additions: 0,
          deletions: 25,
          changes: 25,
        },
      ],
    });

    const pipeline = new PullRequestReviewPipeline(mocks.dependencies);

    await pipeline.execute(createEvent());

    expect(mocks.reviewStateCoordinator.review).toHaveBeenCalledWith(
      expect.any(Object),
      [],
      expect.any(Function),
      ["src/old-service.ts"],
    );
  });
});
