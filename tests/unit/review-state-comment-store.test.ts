import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";

import {
  GitHubReviewStateCommentStore,
  extractStateBlock,
  withStateBlock,
} from "../../src/github/review-state-comment-store.js";
import { RESULT_MARKER } from "../../src/github/result-comment-renderer.js";

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

  const deleteComment = vi.fn().mockResolvedValue({});

  const octokit = {
    rest: {
      issues: {
        listComments,
        createComment,
        updateComment,
        deleteComment,
      },
    },
  } as unknown as Octokit;

  return {
    store: new GitHubReviewStateCommentStore(octokit, SECRET),
    listComments,
    createComment,
    updateComment,
    deleteComment,
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

  it("migrates an old separate state comment into the summary comment", async () => {
    const { store, listComments, createComment, updateComment, deleteComment } =
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

    // State moves into a summary comment; the old state comment is removed.
    expect(createComment).toHaveBeenCalledOnce();
    expect(createComment.mock.calls[0][0].body).toContain(RESULT_MARKER);
    expect(createComment.mock.calls[0][0].body).toContain(START_MARKER);
    expect(deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 100 }),
    );
    expect(updateComment).not.toHaveBeenCalled();
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

  describe("state kept inside the summary comment", () => {
    const SUMMARY = `${RESULT_MARKER}\n## ❌ AI quality gate: not ready to merge\n\n- **A finding**`;

    it("creates one summary-style comment whose state is hidden", async () => {
      const { store, createComment } = createCommentStore();

      await store.save(validState);

      const body: string = createComment.mock.calls[0][0].body;
      const visible = body.replace(/<!--[\s\S]*?-->/g, "").trim();

      expect(body.startsWith(RESULT_MARKER)).toBe(true);
      expect(visible).toContain("review in progress");
      expect(visible).not.toMatch(/[A-Za-z0-9+/=]{40,}/);
    });

    it("updates the summary in place and keeps its visible text", async () => {
      const { store, createComment, listComments, updateComment } =
        createCommentStore();

      await store.save(validState);
      const first: string = createComment.mock.calls[0][0].body;
      const summaryWithState = withStateBlock(
        SUMMARY,
        extractStateBlock(first),
      );

      listComments.mockResolvedValue({
        data: [{ id: 7, body: summaryWithState }],
      });

      await store.save({ ...validState, headSha: "head999" });

      const updated: string = updateComment.mock.calls[0][0].body;
      expect(updateComment.mock.calls[0][0].comment_id).toBe(7);
      expect(updated).toContain("**A finding**");
      expect(updated.match(/AI_QUALITY_GATE_STATE_START/g)).toHaveLength(1);
      expect(updated).not.toBe(summaryWithState);
      expect(createComment).toHaveBeenCalledTimes(1);
    });

    it("loads the state stored in the summary comment", async () => {
      const { store, createComment, listComments } = createCommentStore();

      await store.save(validState);
      const block = extractStateBlock(createComment.mock.calls[0][0].body);

      listComments.mockResolvedValue({
        data: [{ id: 7, body: withStateBlock(SUMMARY, block) }],
      });

      await expect(
        store.load({ repository: REPOSITORY, pullRequestNumber: PR_NUMBER }),
      ).resolves.toEqual(validState);
    });

    it("returns null for a summary that has no state yet", async () => {
      const { store, listComments } = createCommentStore();

      listComments.mockResolvedValue({ data: [{ id: 7, body: SUMMARY }] });

      await expect(
        store.load({ repository: REPOSITORY, pullRequestNumber: PR_NUMBER }),
      ).resolves.toBeNull();
    });

    it("rejects a tampered signature inside the summary comment", async () => {
      const { store, createComment, listComments } = createCommentStore();

      await store.save(validState);
      const block = extractStateBlock(createComment.mock.calls[0][0].body)!;
      const encoded = /<!-- ([A-Za-z0-9+/=]+) -->/.exec(block)![1];
      const envelope = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
      envelope.signature = "0".repeat(64);
      const tampered = Buffer.from(JSON.stringify(envelope), "utf8").toString(
        "base64",
      );

      listComments.mockResolvedValue({
        data: [
          {
            id: 7,
            body: withStateBlock(SUMMARY, block.replace(encoded, tampered)),
          },
        ],
      });

      await expect(
        store.load({ repository: REPOSITORY, pullRequestNumber: PR_NUMBER }),
      ).rejects.toBeInstanceOf(ReviewStateStoreError);

      await expect(store.save(validState)).rejects.toBeInstanceOf(
        ReviewStateStoreError,
      );
    });

    it("refuses to write when the markers in the summary are malformed", async () => {
      const { store, listComments, updateComment } = createCommentStore();

      listComments.mockResolvedValue({
        data: [{ id: 7, body: `${SUMMARY}\n${START_MARKER}\nbroken` }],
      });

      await expect(store.save(validState)).rejects.toBeInstanceOf(
        ReviewStateStoreError,
      );
      expect(updateComment).not.toHaveBeenCalled();
    });

    it("fails clearly when the state is too large for one comment", async () => {
      const { store, createComment } = createCommentStore();
      const text = "x".repeat(1500);

      // A schema-valid state that is simply too big for a single comment.
      const huge: ReviewState = {
        ...validState,
        findings: Array.from({ length: 12 }, (_, index) => ({
          id: `finding-${index}`,
          severity: "BLOCKER" as const,
          category: "correctness" as const,
          file: "src/a.ts",
          line: index + 1,
          title: `Finding ${index}`,
          description: text,
          impact: text,
          suggested_fix: text,
          evidence: text,
          occurrence: "new" as const,
          status: "open" as const,
        })),
      };

      await expect(store.save(huge)).rejects.toMatchObject({
        message: expect.stringContaining("too large"),
      });
      expect(createComment).not.toHaveBeenCalled();
    });

    it("still saves when deleting the old state comment fails", async () => {
      const { store, listComments, createComment, deleteComment } =
        createCommentStore();

      deleteComment.mockRejectedValue(new Error("403"));
      listComments.mockResolvedValue({
        data: [createStateComment(validState)],
      });

      await expect(store.save(validState)).resolves.toBeUndefined();
      expect(createComment).toHaveBeenCalledOnce();
    });

    it("extract/with helpers keep exactly one state block", () => {
      const block =
        "<!-- AI_QUALITY_GATE_STATE_START -->\n<!-- eA== -->\n<!-- AI_QUALITY_GATE_STATE_END -->";
      const body = withStateBlock("visible", block);

      expect(extractStateBlock(body)).toBe(block);
      expect(withStateBlock("new text", extractStateBlock(body))).toContain(
        "new text",
      );
      expect(extractStateBlock("no state here")).toBeNull();
      expect(extractStateBlock(`${block}\n${block}`)).toBeNull();
      expect(withStateBlock("only visible", null)).toBe("only visible");
    });
  });
});
