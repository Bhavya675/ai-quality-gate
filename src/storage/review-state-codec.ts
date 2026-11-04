import { createHmac, timingSafeEqual } from "node:crypto";

import {
  ReviewStateKeySchema,
  ReviewStateSchema,
  type ReviewState,
  type ReviewStateKey,
} from "./review-state.js";

import { z } from "zod";

const ReviewStateEnvelopeSchema = z
  .object({
    version: z.literal(1),
    payload: z.string().min(1),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export class ReviewStateCodecError extends Error {
  constructor(
    public readonly code:
      | "INVALID_SECRET"
      | "INVALID_STATE"
      | "INVALID_ENVELOPE"
      | "INTEGRITY_CHECK_FAILED"
      | "INVALID_PAYLOAD"
      | "KEY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ReviewStateCodecError";
  }
}

function validateSecret(secret: string): void {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new ReviewStateCodecError(
      "INVALID_SECRET",
      "Review-state signing secret must contain at least 32 bytes.",
    );
  }
}

function calculateSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Serializes and signs a review state.
 *
 * The returned envelope contains the JSON payload and its HMAC signature.
 */
export function encodeReviewState(input: ReviewState, secret: string): string {
  validateSecret(secret);

  const validation = ReviewStateSchema.safeParse(input);

  if (!validation.success) {
    throw new ReviewStateCodecError(
      "INVALID_STATE",
      "Cannot serialize an invalid review state.",
    );
  }

  const payload = JSON.stringify(validation.data);

  const signature = calculateSignature(payload, secret);

  return JSON.stringify({
    version: 1,
    payload,
    signature,
  });
}

/**
 * Verifies and deserializes a persisted review state.
 *
 * Optionally validates the expected repository and pull request identity.
 */
export function decodeReviewState(
  serialized: string,
  secret: string,
  expectedKey?: ReviewStateKey,
): ReviewState {
  validateSecret(secret);

  let parsedEnvelope: unknown;

  try {
    parsedEnvelope = JSON.parse(serialized);
  } catch {
    throw new ReviewStateCodecError(
      "INVALID_ENVELOPE",
      "Persisted review state is not valid JSON.",
    );
  }

  const envelopeValidation =
    ReviewStateEnvelopeSchema.safeParse(parsedEnvelope);

  if (!envelopeValidation.success) {
    throw new ReviewStateCodecError(
      "INVALID_ENVELOPE",
      "Persisted review-state envelope is invalid.",
    );
  }

  const envelope = envelopeValidation.data;

  const expectedSignature = calculateSignature(envelope.payload, secret);

  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  const actualBuffer = Buffer.from(envelope.signature, "hex");

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new ReviewStateCodecError(
      "INTEGRITY_CHECK_FAILED",
      "Review-state integrity verification failed.",
    );
  }

  let parsedPayload: unknown;

  try {
    parsedPayload = JSON.parse(envelope.payload);
  } catch {
    throw new ReviewStateCodecError(
      "INVALID_PAYLOAD",
      "Signed review-state payload is invalid JSON.",
    );
  }

  const stateValidation = ReviewStateSchema.safeParse(parsedPayload);

  if (!stateValidation.success) {
    throw new ReviewStateCodecError(
      "INVALID_PAYLOAD",
      "Signed review-state payload does not match the required schema.",
    );
  }

  const state = stateValidation.data;

  if (expectedKey !== undefined) {
    const keyValidation = ReviewStateKeySchema.safeParse(expectedKey);

    if (!keyValidation.success) {
      throw new ReviewStateCodecError(
        "KEY_MISMATCH",
        "Expected review-state identity is invalid.",
      );
    }

    if (
      state.repository !== keyValidation.data.repository ||
      state.pullRequestNumber !== keyValidation.data.pullRequestNumber
    ) {
      throw new ReviewStateCodecError(
        "KEY_MISMATCH",
        "Persisted review state belongs to a different pull request.",
      );
    }
  }

  return state;
}
