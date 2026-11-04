import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";

import { GitHubReviewStateCommentStore } from "../../src/github/review-state-comment-store.js";

import { ReviewStateStoreError } from "../../src/storage/review-state-store.js";

import type { ReviewState } from "../../src/storage/review-state.js";

const SECRET = "test-review-state-secret-with-at-least-32-bytes";

const REPOSITORY = "Bhavya675/ai-quality-gate";
const PR_NUMBER = 10;

const validState: ReviewState = {
  schemaVersion: 1,
  repository: REPOSITORY,
  pullRequestNumber: PR_NUMBER,
  baseSha: "base123",
  headSha: "head123",
  policyVersion: "v1",
  guidelinesSha: "guidelines123",
  verdict: "FAIL",
  findings: [],
  updatedAt: "2026-11-03T10:00:00.000Z",
};

const START_MARKER = "<!-- AI_QUALITY_GATE_STATE_START -->";
const END_MARKER = "<!-- AI_QUALITY_GATE_STATE_END -->";

function createCommentStore() {
  const listComments = vi.fn().mockResolvedValue({
    data: [],
  });

  const createComment = vi.fn().mockResolvedValue({
    data: { id: 100 },
  });

  const updateComment = vi.fn().mockResolvedValue({
    data: { id: 100 },
  });

  const octokit = {
    rest: {
      issues: {
        listComments,
        createComment,
        updateComment,
      },
    },
  } as unknown as Octokit;

  return {
    store: new GitHubReviewStateCommentStore(octokit, SECRET),
    listComments,
    createComment,
    updateComment,
  };
}

function createStateComment(state: ReviewState, commentId = 100) {
  const payload = JSON.stringify(state);

  const envelope = {
    version: 1,
    payload,
    signature: "invalid",
  };

  // Create a valid signed comment using the actual codec.
  const { encodeReviewState } = requireCodec();
  const serialized = encodeReviewState(state, SECRET);

  const encoded = Buffer.from(serialized, "utf8").toString("base64");

  return {
    id: commentId,
    body: [
      "<!-- AI Quality Gate managed state. Do not edit manually. -->",
      START_MARKER,
      encoded,
      END_MARKER,
    ].join("\n"),
  };
}

function requireCodec() {
  return codec;
}

import * as codec from "../../src/storage/review-state-codec.js";

describe("GitHubReviewStateCommentStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the initial state comment", async () => {
    const { store, createComment } = createCommentStore();

    await store.save(validState);

    expect(createComment).toHaveBeenCalledOnce();
    expect(createComment).toHaveBeenCalledWith({
      owner: "Bhavya675",
      repo: "ai-quality-gate",
      issue_number: PR_NUMBER,
      body: expect.stringContaining(START_MARKER),
    });
  });

  it("loads an existing valid state comment", async () => {
    const { store, listComments } = createCommentStore();

    listComments.mockResolvedValue({
      data: [createStateComment(validState)],
    });

    const result = await store.load({
      repository: REPOSITORY,
      pullRequestNumber: PR_NUMBER,
    });

    expect(result).toEqual(validState);
  });

  it("returns null when no state comment exists", async () => {
    const { store } = createCommentStore();

    const result = await store.load({
      repository: REPOSITORY,
      pullRequestNumber: PR_NUMBER,
    });

    expect(result).toBeNull();
  });

  it("updates an existing state comment instead of creating another", async () => {
    const { store, listComments, createComment, updateComment } =
      createCommentStore();

    listComments.mockResolvedValue({
      data: [createStateComment(validState)],
    });

    const updatedState: ReviewState = {
      ...validState,
      headSha: "head456",
      updatedAt: "2026-11-03T11:00:00.000Z",
    };

    await store.save(updatedState);

    expect(updateComment).toHaveBeenCalledOnce();
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "Bhavya675",
        repo: "ai-quality-gate",
        comment_id: 100,
      }),
    );

    expect(createComment).not.toHaveBeenCalled();
  });

  it("rejects a corrupted state signature during loading", async () => {
    const { store, listComments } = createCommentStore();

    const comment = createStateComment(validState);

    const encoded = comment.body!.split("\n")[2];
    const serialized = Buffer.from(encoded, "base64").toString("utf8");
    const envelope = JSON.parse(serialized);

    envelope.signature = "0".repeat(64);

    const tamperedSerialized = JSON.stringify(envelope);
    const tamperedEncoded = Buffer.from(tamperedSerialized, "utf8").toString(
      "base64",
    );

    comment.body = [
      "<!-- AI Quality Gate managed state. Do not edit manually. -->",
      START_MARKER,
      tamperedEncoded,
      END_MARKER,
    ].join("\n");

    listComments.mockResolvedValue({
      data: [comment],
    });

    await expect(
      store.load({
        repository: REPOSITORY,
        pullRequestNumber: PR_NUMBER,
      }),
    ).rejects.toMatchObject({
      code: "LOAD_FAILED",
    });
  });

  it("rejects multiple state comments", async () => {
    const { store, listComments } = createCommentStore();

    listComments.mockResolvedValue({
      data: [
        createStateComment(validState, 100),
        createStateComment(validState, 101),
      ],
    });

    await expect(
      store.load({
        repository: REPOSITORY,
        pullRequestNumber: PR_NUMBER,
      }),
    ).rejects.toMatchObject({
      code: "CONCURRENT_UPDATE",
    });
  });

  it("rejects invalid repository identity", async () => {
    const { store } = createCommentStore();

    await expect(
      store.load({
        repository: "invalid-repository",
        pullRequestNumber: PR_NUMBER,
      }),
    ).rejects.toThrow(ReviewStateStoreError);
  });

  it("rejects an invalid state before saving", async () => {
    const { store, createComment } = createCommentStore();

    const invalidState = {
      ...validState,
      pullRequestNumber: 0,
    };

    await expect(store.save(invalidState as ReviewState)).rejects.toMatchObject(
      {
        code: "INVALID_STATE",
      },
    );

    expect(createComment).not.toHaveBeenCalled();
  });

  it("rejects saving over a corrupted existing state", async () => {
    const { store, listComments, updateComment } = createCommentStore();

    const comment = createStateComment(validState);

    // Extract the Base64-encoded envelope.
    const encoded = comment.body!.split("\n")[2];

    // Decode the envelope.
    const serialized = Buffer.from(encoded, "base64").toString("utf8");

    const envelope = JSON.parse(serialized);

    // Tamper with the HMAC signature.
    envelope.signature = "0".repeat(64);

    // Re-encode the modified envelope.
    const tamperedSerialized = JSON.stringify(envelope);

    const tamperedEncoded = Buffer.from(tamperedSerialized, "utf8").toString(
      "base64",
    );

    comment.body = [
      "<!-- AI Quality Gate managed state. Do not edit manually. -->",
      START_MARKER,
      tamperedEncoded,
      END_MARKER,
    ].join("\n");

    listComments.mockResolvedValue({
      data: [comment],
    });

    await expect(
      store.save({
        ...validState,
        headSha: "head456",
      }),
    ).rejects.toThrow(ReviewStateStoreError);

    expect(updateComment).not.toHaveBeenCalled();
  });

  it("rejects GitHub API failures during loading", async () => {
    const { store, listComments } = createCommentStore();

    listComments.mockRejectedValue(new Error("GitHub API unavailable"));

    await expect(
      store.load({
        repository: REPOSITORY,
        pullRequestNumber: PR_NUMBER,
      }),
    ).rejects.toMatchObject({
      code: "LOAD_FAILED",
    });
  });

  it("rejects GitHub API failures during saving", async () => {
    const { store, createComment } = createCommentStore();

    createComment.mockRejectedValue(new Error("GitHub API unavailable"));

    await expect(store.save(validState)).rejects.toMatchObject({
      code: "SAVE_FAILED",
    });
  });
});
