import { describe, expect, it, vi } from "vitest";

import {
  ReviewStateCoordinator,
  ReviewStateCoordinatorError,
} from "../../src/review/review-state-coordinator.js";

import type { ReviewState } from "../../src/storage/review-state.js";

import type { ReviewStateStore } from "../../src/storage/review-state-store.js";

import type {
  ReviewService,
  CompletedReview,
} from "../../src/review/review-service.js";

import type { AiReviewRequest } from "../../src/gateway/ai-gateway.js";

const request: AiReviewRequest = {
  requestId: "test-001",
  repository: "Bhavya675/ai-quality-gate",
  pullRequestNumber: 10,
  baseSha: "base123",
  headSha: "head123",
  systemPrompt: "Review the code.",
  userPrompt: "Find genuine defects.",
  maxTokens: 1024,
};

const previousState: ReviewState = {
  schemaVersion: 1,
  repository: request.repository,
  pullRequestNumber: request.pullRequestNumber,
  baseSha: "base-old",
  headSha: "head-old",
  policyVersion: "v1",
  guidelinesSha: "guidelines-old",
  verdict: "FAIL",
  findings: [],
  updatedAt: "2026-11-02T10:00:00.000Z",
};

function createCompletedReview(reviewComplete = true): CompletedReview {
  const review = {
    commit_sha: request.headSha,
    verdict: "PASS" as const,
    summary: "No blockers identified.",
    findings: [],
    sensitive_categories: [],
    review_complete: reviewComplete,
  };

  const verdict = {
    verdict: "PASS" as const,
    summary: "No blockers identified.",
    blockerCount: 0,
    worthALookCount: 0,
    nitCount: 0,
  };

  return {
    review,
    verdict,
    findingPolicy: {
      findings: [],
      totalFindings: 0,
      retainedFindings: 0,
      omittedWorthALook: 0,
      omittedNits: 0,
    },
    deduplication: {
      findings: [],
      duplicatesRemoved: 0,
    },
    tracking: {
      currentFindings: [],
      newFindingCount: 0,
      previouslyReportedCount: 0,
      unverifiedPreviousFindings: [],
    },
    resolutions: [],
  };
}

function createCoordinator(options?: {
  previousState?: ReviewState | null;
  reviewError?: boolean;
  loadError?: boolean;
  saveError?: boolean;
  reviewComplete?: boolean;
}) {
  const completedReview = createCompletedReview(
    options?.reviewComplete ?? true,
  );

  const review = vi.fn().mockResolvedValue(completedReview);

  if (options?.reviewError) {
    review.mockRejectedValue(new Error("Review failed"));
  }

  const load = vi.fn().mockResolvedValue(options?.previousState ?? null);

  if (options?.loadError) {
    load.mockRejectedValue(new Error("Load failed"));
  }

  const save = vi.fn().mockResolvedValue(undefined);

  if (options?.saveError) {
    save.mockRejectedValue(new Error("Save failed"));
  }

  const reviewService = {
    review,
  } as unknown as Pick<ReviewService, "review">;

  const stateStore = {
    load,
    save,
  } as ReviewStateStore;

  const coordinator = new ReviewStateCoordinator(reviewService, stateStore, {
    policyVersion: "v1",
    guidelinesSha: "guidelines123",
  });

  return {
    coordinator,
    review,
    load,
    save,
    completedReview,
  };
}

describe("ReviewStateCoordinator", () => {
  it("runs the freshness check before saving state", async () => {
    const executionOrder: string[] = [];

    const completedReview = {
      review: {
        commit_sha: "b".repeat(40),
        verdict: "PASS",
        summary: "No blockers identified.",
        findings: [],
        sensitive_categories: [],
        review_complete: true,
      },
      verdict: {
        verdict: "PASS",
        summary: "No blockers identified.",
        blockerCount: 0,
        worthALookCount: 0,
        nitCount: 0,
      },
      findingPolicy: {},
      deduplication: {},
      tracking: {},
      resolutions: [],
    } as any;

    const stateStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockImplementation(async () => {
        executionOrder.push("save");
      }),
    };

    const reviewService = {
      review: vi.fn().mockImplementation(async () => {
        executionOrder.push("review");
        return completedReview;
      }),
    };

    const coordinator = new ReviewStateCoordinator(reviewService, stateStore, {
      policyVersion: "1.0.0",
      guidelinesSha: "guidelines-sha",
    });

    await coordinator.review(
      {
        requestId: "test-request",
        repository: "owner/repository",
        pullRequestNumber: 12,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        systemPrompt: "System",
        userPrompt: "Review",
        maxTokens: 8192,
      },
      [],
      async () => {
        executionOrder.push("freshness-check");
      },
    );

    expect(executionOrder).toEqual(["review", "freshness-check", "save"]);
  });

  it("does not persist a review when freshness verification fails", async () => {
    const stateStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
    };

    const reviewService = {
      review: vi.fn().mockResolvedValue({
        review: {
          commit_sha: "b".repeat(40),
          verdict: "PASS",
          summary: "No blockers identified.",
          findings: [],
          sensitive_categories: [],
          review_complete: true,
        },
        verdict: {
          verdict: "PASS",
          summary: "No blockers identified.",
          blockerCount: 0,
          worthALookCount: 0,
          nitCount: 0,
        },
        findingPolicy: {},
        deduplication: {},
        tracking: {},
        resolutions: [],
      } as any),
    };

    const coordinator = new ReviewStateCoordinator(reviewService, stateStore, {
      policyVersion: "1.0.0",
      guidelinesSha: "guidelines-sha",
    });

    await expect(
      coordinator.review(
        {
          requestId: "test-request",
          repository: "owner/repository",
          pullRequestNumber: 12,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          systemPrompt: "System",
          userPrompt: "Review",
          maxTokens: 8192,
        },
        [],
        async () => {
          throw new Error("Stale commit");
        },
      ),
    ).rejects.toThrow("Stale commit");

    expect(stateStore.save).not.toHaveBeenCalled();
  });

  it("does not persist an incomplete review", async () => {
    const stateStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
    };

    const reviewService = {
      review: vi.fn().mockResolvedValue({
        review: {
          commit_sha: "b".repeat(40),
          verdict: "FAIL",
          summary: "Review incomplete.",
          findings: [],
          sensitive_categories: [],
          review_complete: false,
        },
        verdict: {
          verdict: "FAIL",
          summary: "Review incomplete.",
          blockerCount: 0,
          worthALookCount: 0,
          nitCount: 0,
        },
        findingPolicy: {},
        deduplication: {},
        tracking: {},
        resolutions: [],
      } as any),
    };

    const coordinator = new ReviewStateCoordinator(reviewService, stateStore, {
      policyVersion: "1.0.0",
      guidelinesSha: "guidelines-sha",
    });

    const result = await coordinator.review(
      {
        requestId: "test-request",
        repository: "owner/repository",
        pullRequestNumber: 12,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        systemPrompt: "System",
        userPrompt: "Review",
        maxTokens: 8192,
      },
      [],
    );

    expect(result.persisted).toBe(false);
    expect(stateStore.save).not.toHaveBeenCalled();
  });

  it("loads previous state and persists the completed review", async () => {
    const { coordinator, load, save } = createCoordinator({
      previousState,
    });

    const result = await coordinator.review(request);

    expect(load).toHaveBeenCalledWith({
      repository: request.repository,
      pullRequestNumber: request.pullRequestNumber,
    });

    expect(save).toHaveBeenCalledOnce();

    expect(result.persisted).toBe(true);
    expect(result.previousState).toEqual(previousState);
  });

  it("passes previous findings to ReviewService", async () => {
    const { coordinator, review } = createCoordinator({
      previousState,
    });

    await coordinator.review(request);

    expect(review).toHaveBeenCalledWith(request, previousState.findings, []);
  });

  it("starts with an empty finding history when no state exists", async () => {
    const { coordinator, review } = createCoordinator({
      previousState: null,
    });

    const result = await coordinator.review(request);

    expect(review).toHaveBeenCalledWith(request, [], []);

    expect(result.previousState).toBeNull();
    expect(result.persisted).toBe(true);
  });

  it("does not persist an incomplete review", async () => {
    const { coordinator, save } = createCoordinator({
      previousState,
      reviewComplete: false,
    });

    const result = await coordinator.review(request);

    expect(result.persisted).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("fails when previous state cannot be loaded", async () => {
    const { coordinator, review } = createCoordinator({
      loadError: true,
    });

    await expect(coordinator.review(request)).rejects.toMatchObject({
      code: "STATE_LOAD_FAILED",
    });

    expect(review).not.toHaveBeenCalled();
  });

  it("fails when review execution fails", async () => {
    const { coordinator, save } = createCoordinator({
      reviewError: true,
    });

    await expect(coordinator.review(request)).rejects.toMatchObject({
      code: "REVIEW_FAILED",
    });

    expect(save).not.toHaveBeenCalled();
  });

  it("fails when completed review state cannot be saved", async () => {
    const { coordinator } = createCoordinator({
      saveError: true,
    });

    await expect(coordinator.review(request)).rejects.toMatchObject({
      code: "STATE_SAVE_FAILED",
    });
  });

  it("persists the current commit and review policy metadata", async () => {
    const { coordinator, save } = createCoordinator();

    await coordinator.review(request);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        repository: request.repository,
        pullRequestNumber: request.pullRequestNumber,
        baseSha: request.baseSha,
        headSha: request.headSha,
        policyVersion: "v1",
        guidelinesSha: "guidelines123",
        verdict: "PASS",
        findings: [],
      }),
    );
  });
});
