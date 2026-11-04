import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),

  GEMINI_MODEL: z.string().min(1, "GEMINI_MODEL is required"),

  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),

  REVIEW_STATE_SIGNING_SECRET: z
    .string()
    .min(32, "REVIEW_STATE_SIGNING_SECRET must contain at least 32 characters"),

  REVIEW_POLICY_VERSION: z.string().min(1).default("1.0.0"),

  REVIEW_GUIDELINES_SHA: z.string().min(1),
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  const errors = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment configuration:\n${errors}`);
}

export const env = Object.freeze(result.data);
