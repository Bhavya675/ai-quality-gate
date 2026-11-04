import { GoogleGenAI } from "@google/genai";
import { ReviewResultJsonSchema } from "../../validation/review-result-json-schema.js";

import type {
  AiProvider,
  AiReviewRequest,
  AiReviewResponse,
} from "../ai-gateway.js";

export class GeminiProvider implements AiProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    if (!apiKey.trim()) {
      throw new Error("Gemini API key is required.");
    }

    if (!model.trim()) {
      throw new Error("Gemini model is required.");
    }

    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async generate(
    request: AiReviewRequest,
    signal: AbortSignal,
  ): Promise<AiReviewResponse> {
    if (signal.aborted) {
      throw new Error("Gemini request was cancelled.");
    }

    const interaction = await this.client.interactions.create(
      {
        model: this.model,
        input: [
          {
            type: "text",
            text: request.userPrompt,
          },
        ],
        system_instruction: request.systemPrompt,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: ReviewResultJsonSchema,
        },
      },
      {
        signal,
      },
    );

    const content = interaction.output_text;

    if (!content?.trim()) {
      throw new Error("Gemini returned an empty response.");
    }

    return {
      content,
      provider: "gemini",
      model: this.model,
    };
  }
}
