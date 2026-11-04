import { describe, expect, it } from "vitest";
import {
  assertHeadShaCurrent,
  createPullRequestLockKey,
  PullRequestReviewGuard,
  PullRequestReviewGuardError,
} from "../../src/github/pull-request-review-guard.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("createPullRequestLockKey", () => {
  it("creates a normalized pull request lock key", () => {
    expect(createPullRequestLockKey("Bhavya675", "AI-Quality-Gate", 12)).toBe(
      "bhavya675/ai-quality-gate#12",
    );
  });

  it("rejects an invalid pull request identity", () => {
    expect(() => createPullRequestLockKey("", "repository", 12)).toThrowError(
      PullRequestReviewGuardError,
    );
  });

  it("rejects an invalid pull request number", () => {
    expect(() =>
      createPullRequestLockKey("owner", "repository", 0),
    ).toThrowError(PullRequestReviewGuardError);
  });
});

describe("PullRequestReviewGuard", () => {
  it("executes operations for the same PR sequentially", async () => {
    const guard = new PullRequestReviewGuard();
    const executionOrder: string[] = [];

    let releaseFirst!: () => void;

    const firstOperation = guard.runExclusive(
      "owner",
      "repository",
      12,
      async () => {
        executionOrder.push("first-start");

        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });

        executionOrder.push("first-end");
      },
    );

    // Wait until the first operation has acquired the lock.
    while (!releaseFirst) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const secondOperation = guard.runExclusive(
      "owner",
      "repository",
      12,
      async () => {
        executionOrder.push("second-start");
      },
    );

    await Promise.resolve();

    expect(executionOrder).toEqual(["first-start"]);

    releaseFirst();

    await Promise.all([firstOperation, secondOperation]);

    expect(executionOrder).toEqual([
      "first-start",
      "first-end",
      "second-start",
    ]);
  });

  it("allows different PRs to execute independently", async () => {
    const guard = new PullRequestReviewGuard();
    const executionOrder: string[] = [];

    let releaseFirst!: () => void;

    const firstOperation = guard.runExclusive(
      "owner",
      "repository",
      12,
      async () => {
        executionOrder.push("first-start");

        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });

        executionOrder.push("first-end");
      },
    );

    while (!releaseFirst) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const secondOperation = guard.runExclusive(
      "owner",
      "repository",
      13,
      async () => {
        executionOrder.push("second-start");
      },
    );

    await secondOperation;

    expect(executionOrder).toEqual(["first-start", "second-start"]);

    releaseFirst();
    await firstOperation;
  });

  it("releases the lock when an operation fails", async () => {
    const guard = new PullRequestReviewGuard();

    await expect(
      guard.runExclusive("owner", "repository", 12, async () => {
        throw new Error("Simulated failure");
      }),
    ).rejects.toThrow("Simulated failure");

    const result = await guard.runExclusive(
      "owner",
      "repository",
      12,
      async () => "completed",
    );

    expect(result).toBe("completed");
  });
});

describe("assertHeadShaCurrent", () => {
  it("accepts matching commit SHAs", () => {
    expect(() => assertHeadShaCurrent(SHA_A, SHA_A)).not.toThrow();
  });

  it("accepts matching SHAs with different letter casing", () => {
    expect(() =>
      assertHeadShaCurrent(SHA_A.toUpperCase(), SHA_A),
    ).not.toThrow();
  });

  it("rejects an outdated review", () => {
    expect(() => assertHeadShaCurrent(SHA_A, SHA_B)).toThrowError(
      expect.objectContaining({
        code: "STALE_REVIEW",
      }),
    );
  });

  it("rejects invalid commit SHAs", () => {
    expect(() => assertHeadShaCurrent("invalid", SHA_A)).toThrowError(
      expect.objectContaining({
        code: "INVALID_COMMIT_SHA",
      }),
    );
  });
});
