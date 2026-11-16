import { Type } from "@google/genai";

export const FindingResolutionJsonSchema = {
  type: Type.OBJECT,
  properties: {
    resolutions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          finding_id: { type: Type.STRING },
          decision: {
            type: Type.STRING,
            enum: ["CONFIRMED_FIXED", "STILL_PRESENT", "UNVERIFIED"],
          },
          reasoning: { type: Type.STRING },
          fixed_code_quote: {
            type: Type.STRING,
            description:
              "Verbatim code copied from the CURRENT file that shows the defect is fixed. Empty unless decision is CONFIRMED_FIXED.",
          },
        },
        required: ["finding_id", "decision", "reasoning", "fixed_code_quote"],
      },
    },
  },
  required: ["resolutions"],
};
