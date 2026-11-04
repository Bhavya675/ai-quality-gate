import { Type } from "@google/genai";

export const ReviewResultJsonSchema = {
  type: Type.OBJECT,
  properties: {
    commit_sha: {
      type: Type.STRING,
      description: "The exact commit SHA being reviewed.",
    },
    verdict: {
      type: Type.STRING,
      enum: ["PASS", "FAIL"],
    },
    summary: {
      type: Type.STRING,
      description: "A concise explanation of the overall review result.",
    },
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          severity: {
            type: Type.STRING,
            enum: ["BLOCKER", "WORTH_A_LOOK", "NIT"],
          },
          category: {
            type: Type.STRING,
            enum: [
              "correctness",
              "security",
              "data-loss",
              "database",
              "api-contract",
              "testing",
              "observability",
              "guidelines",
              "human-feedback",
              "performance",
              "architecture",
              "other",
            ],
          },
          file: { type: Type.STRING },
          line: { type: Type.INTEGER },
          end_line: { type: Type.INTEGER },
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          impact: { type: Type.STRING },
          suggested_fix: { type: Type.STRING },
          evidence: { type: Type.STRING },
          occurrence: {
            type: Type.STRING,
            enum: ["new", "previously_reported"],
          },
          status: {
            type: Type.STRING,
            enum: ["open", "resolved"],
          },
        },
        required: [
          "id",
          "severity",
          "category",
          "file",
          "line",
          "title",
          "description",
          "impact",
          "suggested_fix",
          "evidence",
          "occurrence",
          "status",
        ],
      },
    },
    sensitive_categories: {
      type: Type.ARRAY,
      items: {
        type: Type.STRING,
        enum: [
          "auth-identity",
          "money-movement",
          "ledger-reconciliation",
          "card-lifecycle",
          "customer-personal-data",
          "permissions-limits",
          "external-scheme-integration",
        ],
      },
    },
    review_complete: {
      type: Type.BOOLEAN,
    },
  },
  required: [
    "commit_sha",
    "verdict",
    "summary",
    "findings",
    "sensitive_categories",
    "review_complete",
  ],
};
