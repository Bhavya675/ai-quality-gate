import { describe, expect, it } from "vitest";

import {
  decodeReviewState,
  encodeReviewState,
  ReviewStateCodecError,
} from "../../src/storage/review-state-codec.js";

import type { ReviewState } from "../../src/storage/review-state.js";

const SECRET = "test-review-state-secret-with-at-least-32-bytes";

const validState: ReviewState = {
  schemaVersion: 1,
  repository: "Bhavya675/ai-quality-gate",
  pullRequestNumber: 10,
  baseSha: "base123",
  headSha: "head123",
  policyVersion: "v1",
  guidelinesSha: "guidelines123",
  verdict: "FAIL",
  findings: [],
  updatedAt: "2026-11-03T10:00:00.000Z",
};

describe("ReviewStateCodec", () => {
  it("encodes and decodes a valid review state", () => {
    const encoded = encodeReviewState(validState, SECRET);

    const decoded = decodeReviewState(encoded, SECRET);

    expect(decoded).toEqual(validState);
  });

  it("produces a signed envelope", () => {
    const encoded = encodeReviewState(validState, SECRET);
    const envelope = JSON.parse(encoded);

    expect(envelope.version).toBe(1);
    expect(envelope.payload).toBeDefined();
    expect(envelope.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a signing secret shorter than 32 bytes", () => {
    expect(() => encodeReviewState(validState, "short")).toThrowError(
      ReviewStateCodecError,
    );
  });

  it("rejects an invalid state during encoding", () => {
    const invalidState = {
      ...validState,
      pullRequestNumber: 0,
    };

    expect(() =>
      encodeReviewState(invalidState as ReviewState, SECRET),
    ).toThrowError("Cannot serialize an invalid review state.");
  });

  it("rejects malformed envelope JSON", () => {
    expect(() => decodeReviewState("not-json", SECRET)).toThrowError(
      "Persisted review state is not valid JSON.",
    );
  });

  it("rejects a modified payload", () => {
    const encoded = encodeReviewState(validState, SECRET);
    const envelope = JSON.parse(encoded);

    envelope.payload = envelope.payload.replace("head123", "tampered");

    expect(() =>
      decodeReviewState(JSON.stringify(envelope), SECRET),
    ).toThrowError("Review-state integrity verification failed.");
  });

  it("rejects a different signing secret", () => {
    const encoded = encodeReviewState(validState, SECRET);

    expect(() =>
      decodeReviewState(encoded, "another-secret-with-at-least-32-bytes"),
    ).toThrowError("Review-state integrity verification failed.");
  });

  it("rejects an unsupported envelope version", () => {
    const encoded = encodeReviewState(validState, SECRET);
    const envelope = JSON.parse(encoded);

    envelope.version = 2;

    expect(() =>
      decodeReviewState(JSON.stringify(envelope), SECRET),
    ).toThrowError("Persisted review-state envelope is invalid.");
  });

  it("rejects a different repository identity", () => {
    const encoded = encodeReviewState(validState, SECRET);

    expect(() =>
      decodeReviewState(encoded, SECRET, {
        repository: "another/repository",
        pullRequestNumber: 10,
      }),
    ).toThrowError(
      "Persisted review state belongs to a different pull request.",
    );
  });

  it("rejects a different pull request number", () => {
    const encoded = encodeReviewState(validState, SECRET);

    expect(() =>
      decodeReviewState(encoded, SECRET, {
        repository: "Bhavya675/ai-quality-gate",
        pullRequestNumber: 11,
      }),
    ).toThrowError(
      "Persisted review state belongs to a different pull request.",
    );
  });

  it("accepts the matching repository and pull request identity", () => {
    const encoded = encodeReviewState(validState, SECRET);

    const decoded = decodeReviewState(encoded, SECRET, {
      repository: "Bhavya675/ai-quality-gate",
      pullRequestNumber: 10,
    });

    expect(decoded).toEqual(validState);
  });
});
