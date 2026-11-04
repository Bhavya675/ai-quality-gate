import { describe, expect, it, vi } from "vitest";

import {
  AiGateway,
  AiGatewayError,
  type AiProvider,
  type AiReviewRequest,
  type AiReviewResponse,
} from "../../src/gateway/ai-gateway.js";

const validRequest: AiReviewRequest = {
  requestId: "review-001",
  repository: "Bhavya675/ai-quality-gate",
  pullRequestNumber: 1,
  baseSha: "base123",
  headSha: "head123",
  systemPrompt: "Review the code.",
  userPrompt: "Analyze the changes.",
  maxTokens: 8192,
};

const validResponse: AiReviewResponse = {
  content: '{"verdict":"PASS","findings":[]}',
  provider: "test-provider",
  model: "test-model",
};

describe("AI Gateway", () => {
  it("should return a successful provider response", async () => {
    const provider: AiProvider = {
      generate: vi.fn().mockResolvedValue(validResponse),
    };

    const gateway = new AiGateway(provider);

    const result = await gateway.review(validRequest);

    expect(result).toEqual(validResponse);
    expect(provider.generate).toHaveBeenCalledOnce();
  });

  it("should reject invalid requests", async () => {
    const provider: AiProvider = {
      generate: vi.fn(),
    };

    const gateway = new AiGateway(provider);

    await expect(
      gateway.review({
        ...validRequest,
        pullRequestNumber: 0,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });

    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("should reject empty provider responses", async () => {
    const provider: AiProvider = {
      generate: vi.fn().mockResolvedValue({
        ...validResponse,
        content: "",
      }),
    };

    const gateway = new AiGateway(provider);

    await expect(gateway.review(validRequest)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("should handle provider failures", async () => {
    const provider: AiProvider = {
      generate: vi.fn().mockRejectedValue(new Error("Provider unavailable")),
    };

    const gateway = new AiGateway(provider);

    await expect(gateway.review(validRequest)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("should timeout slow provider requests", async () => {
    const provider: AiProvider = {
      generate: vi.fn(() => new Promise<AiReviewResponse>(() => {})),
    };

    const gateway = new AiGateway(provider, 50);

    await expect(gateway.review(validRequest)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});
