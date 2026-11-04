import { describe, expect, it } from "vitest";
import {
  parsePullRequestEvent,
  PullRequestEventError,
} from "../../src/github/pull-request-event.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: {
      name: "ai-quality-gate",
      owner: {
        login: "Bhavya675",
      },
      full_name: "Bhavya675/ai-quality-gate",
    },
    pull_request: {
      number: 12,
      draft: false,
      state: "open",
      merged: false,
      base: {
        sha: BASE_SHA,
        ref: "main",
      },
      head: {
        sha: HEAD_SHA,
        ref: "feature/test",
      },
    },
    ...overrides,
  };
}

describe("parsePullRequestEvent", () => {
  it("accepts a valid opened pull request event", () => {
    const result = parsePullRequestEvent(createPayload());

    expect(result).toEqual({
      accepted: true,
      event: {
        action: "opened",
        repository: "ai-quality-gate",
        owner: "Bhavya675",
        pullRequestNumber: 12,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
    });
  });

  it.each(["opened", "synchronize", "reopened", "ready_for_review"])(
    "accepts the supported action: %s",
    (action) => {
      const result = parsePullRequestEvent(createPayload({ action }));

      expect(result.accepted).toBe(true);
    },
  );

  it("ignores unsupported actions", () => {
    const result = parsePullRequestEvent(createPayload({ action: "closed" }));

    expect(result).toEqual({
      accepted: false,
      reason: "UNSUPPORTED_ACTION",
    });
  });

  it("ignores draft pull requests", () => {
    const result = parsePullRequestEvent(
      createPayload({
        pull_request: {
          ...createPayload().pull_request,
          draft: true,
        },
      }),
    );

    expect(result).toEqual({
      accepted: false,
      reason: "DRAFT_PULL_REQUEST",
    });
  });

  it("ignores closed pull requests", () => {
    const result = parsePullRequestEvent(
      createPayload({
        pull_request: {
          ...createPayload().pull_request,
          state: "closed",
        },
      }),
    );

    expect(result).toEqual({
      accepted: false,
      reason: "PULL_REQUEST_NOT_OPEN",
    });
  });

  it("ignores merged pull requests", () => {
    const result = parsePullRequestEvent(
      createPayload({
        pull_request: {
          ...createPayload().pull_request,
          merged: true,
        },
      }),
    );

    expect(result).toEqual({
      accepted: false,
      reason: "PULL_REQUEST_NOT_OPEN",
    });
  });

  it("rejects a missing repository", () => {
    const payload = createPayload() as Record<string, unknown>;
    delete payload.repository;

    expect(() => parsePullRequestEvent(payload)).toThrowError(
      PullRequestEventError,
    );
  });

  it("rejects an invalid pull request number", () => {
    const result = createPayload({
      pull_request: {
        ...createPayload().pull_request,
        number: 0,
      },
    });

    expect(() => parsePullRequestEvent(result)).toThrowError(
      PullRequestEventError,
    );
  });

  it("rejects an invalid head SHA", () => {
    const result = createPayload({
      pull_request: {
        ...createPayload().pull_request,
        head: { sha: "invalid-sha" },
      },
    });

    expect(() => parsePullRequestEvent(result)).toThrowError(
      PullRequestEventError,
    );
  });

  it("rejects a null payload", () => {
    expect(() => parsePullRequestEvent(null)).toThrowError(
      PullRequestEventError,
    );
  });
});
