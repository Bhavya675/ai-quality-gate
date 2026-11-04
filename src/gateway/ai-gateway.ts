import { z } from "zod";

export const AiReviewRequestSchema = z.object({
  requestId: z.string().min(1),
  repository: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1),
  maxTokens: z.number().int().positive().default(8192),
});

export type AiReviewRequest = z.infer<typeof AiReviewRequestSchema>;

export interface AiReviewResponse {
  content: string;
  provider: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AiProvider {
  generate(
    request: AiReviewRequest,
    signal: AbortSignal,
  ): Promise<AiReviewResponse>;
}

export type AiGatewayErrorCode =
  | "INVALID_REQUEST"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE";

export class AiGatewayError extends Error {
  constructor(
    public readonly code: AiGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiGatewayError";
  }
}

export class AiGateway {
  constructor(
    private readonly provider: AiProvider,
    private readonly timeoutMs = 120_000,
  ) {}

  async review(input: AiReviewRequest): Promise<AiReviewResponse> {
    const validation = AiReviewRequestSchema.safeParse(input);

    if (!validation.success) {
      throw new AiGatewayError("INVALID_REQUEST", "Invalid AI review request.");
    }

    const controller = new AbortController();

    let timeoutHandle: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();

        reject(new AiGatewayError("TIMEOUT", "AI provider request timed out."));
      }, this.timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.provider.generate(validation.data, controller.signal),
        timeoutPromise,
      ]);

      if (
        !response ||
        typeof response.content !== "string" ||
        response.content.trim().length === 0 ||
        !response.provider ||
        !response.model
      ) {
        throw new AiGatewayError(
          "INVALID_RESPONSE",
          "AI provider returned an invalid response.",
        );
      }

      return response;
    } catch (error) {
      if (error instanceof AiGatewayError) {
        throw error;
      }

      const rawMessage =
        error instanceof Error ? error.message : "Unknown provider error";

      // Redact common credential formats before logging.
      const safeMessage = rawMessage
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_API_KEY]")
        .replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
        .slice(0, 1000);

      const status =
        typeof error === "object" && error !== null && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;

      console.error("[AiGateway] Gemini provider request failed.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        status,
        message: safeMessage,
      });

      throw new AiGatewayError(
        "PROVIDER_ERROR",
        "AI provider execution failed.",
      );
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }
}
