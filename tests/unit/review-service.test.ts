import { describe, expect, it, vi } from "vitest";
import {
  ReviewService,
  ReviewServiceError,
} from "../../src/review/review-service.js";
import type {
  AiGateway,
  AiReviewRequest,
} from "../../src/gateway/ai-gateway.js";
import type { ReviewFinding } from "../../src/validation/review-result.js";
import { generateFindingId } from "../../src/review/finding-identity.js";

const request: AiReviewRequest = {
  requestId: "test-001",
  repository: "demo/ai-quality-gate",
  pullRequestNumber: 1,
  baseSha: "base123",
  headSha: "head123",
  systemPrompt: "Review the code.",
  userPrompt: "Find genuine defects.",
  maxTokens: 1024,
};

const validAiReview = {
  commit_sha: "head123",
  verdict: "PASS",
  summary: "No blockers identified.",
  findings: [],
  sensitive_categories: [],
  review_complete: true,
};

function createFinding(
  severity: "BLOCKER" | "WORTH_A_LOOK" | "NIT",
  id: string,
  status: "open" | "resolved" = "open",
  title = `Finding ${id}`,
): ReviewFinding {
  return {
    id,
    severity,
    category: "correctness",
    file: "src/example.ts",
    line: 10,
    title,
    description: "Example description.",
    impact: "Example impact.",
    suggested_fix: "Example fix.",
    evidence: "Example evidence.",
    occurrence: "new",
    status,
  };
}

function createService(responseContent: string) {
  const gateway = {
    review: vi.fn().mockResolvedValue({
      content: responseContent,
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
    }),
  } as unknown as AiGateway;

  return new ReviewService(gateway);
}

describe("ReviewService", () => {
  it("retains all blockers even when there are more than five", async () => {
    const findings = Array.from({ length: 7 }, (_, i) =>
      createFinding("BLOCKER", `blocker-${i}`),
    );

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        verdict: "FAIL",
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.review.findings).toHaveLength(7);
    expect(result.verdict.blockerCount).toBe(7);
    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("limits open worth-a-look findings to five", async () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      createFinding("WORTH_A_LOOK", `look-${i}`),
    );

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.review.findings).toHaveLength(5);
    expect(result.findingPolicy.omittedWorthALook).toBe(3);
    expect(result.verdict.verdict).toBe("PASS");
  });

  it("limits open nit findings to three", async () => {
    const findings = Array.from({ length: 6 }, (_, i) =>
      createFinding("NIT", `nit-${i}`),
    );

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.review.findings).toHaveLength(3);
    expect(result.findingPolicy.omittedNits).toBe(3);
    expect(result.verdict.verdict).toBe("PASS");
  });

  it("does not allow AI output to mark findings as resolved", async () => {
    const findings = [
      createFinding("BLOCKER", "resolved-blocker", "resolved"),
      createFinding("WORTH_A_LOOK", "resolved-look", "resolved"),
    ];

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.review.findings).toHaveLength(2);
    expect(
      result.review.findings.every((finding) => finding.status === "open"),
    ).toBe(true);
    expect(result.verdict.blockerCount).toBe(1);
    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("accepts valid AI JSON and calculates PASS", async () => {
    const service = createService(JSON.stringify(validAiReview));

    const result = await service.review(request);

    expect(result.review.verdict).toBe("PASS");
    expect(result.verdict.verdict).toBe("PASS");
  });

  it("rejects malformed JSON", async () => {
    const service = createService("{ invalid json }");

    await expect(service.review(request)).rejects.toMatchObject({
      name: "ReviewServiceError",
      code: "INVALID_JSON",
    });
  });

  it("rejects a mismatched commit SHA", async () => {
    const service = createService(
      JSON.stringify({
        ...validAiReview,
        commit_sha: "different-commit",
      }),
    );

    await expect(service.review(request)).rejects.toMatchObject({
      name: "ReviewServiceError",
      code: "COMMIT_MISMATCH",
    });
  });

  it("converts AI PASS to FAIL when an open blocker exists", async () => {
    const blockerReview = {
      ...validAiReview,
      findings: [
        {
          id: "finding-001",
          severity: "BLOCKER",
          category: "security",
          file: "src/services/user.ts",
          line: 42,
          title: "Missing authorization validation",
          description: "The operation does not verify caller permissions.",
          impact: "Unauthorized users may modify protected records.",
          suggested_fix: "Add authorization validation.",
          evidence: "The update executes without checking caller permissions.",
          occurrence: "new",
          status: "open",
        },
      ],
    };

    const service = createService(JSON.stringify(blockerReview));

    const result = await service.review(request);

    expect(result.review.verdict).toBe("FAIL");
    expect(result.verdict.verdict).toBe("FAIL");
    expect(result.verdict.blockerCount).toBe(1);
  });

  it("removes duplicate findings and generates a stable server-side ID", async () => {
    const findings = [
      createFinding("BLOCKER", "ai-id-001", "open", "Missing authorization"),
      createFinding("BLOCKER", "ai-id-002", "open", "Missing authorization"),
    ];

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.review.findings).toHaveLength(1);
    expect(result.deduplication.duplicatesRemoved).toBe(1);

    expect(result.review.findings[0].id).not.toBe("ai-id-001");
    expect(result.review.findings[0].id).not.toBe("ai-id-002");
  });

  it("prefers an open finding over a resolved duplicate", async () => {
    const findings = [
      createFinding(
        "BLOCKER",
        "resolved-id",
        "resolved",
        "Missing authorization",
      ),
      createFinding("BLOCKER", "open-id", "open", "Missing authorization"),
    ];

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.review.findings).toHaveLength(1);
    expect(result.review.findings[0].status).toBe("open");
    expect(result.verdict.verdict).toBe("FAIL");
    expect(result.verdict.blockerCount).toBe(1);
  });

  it("preserves findings with different identities", async () => {
    const findings = [
      createFinding("BLOCKER", "finding-001", "open", "Missing authorization"),
      createFinding(
        "BLOCKER",
        "finding-002",
        "open",
        "Missing input validation",
      ),
    ];

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.review.findings).toHaveLength(2);
    expect(result.deduplication.duplicatesRemoved).toBe(0);
  });

  it("applies finding limits after removing duplicates", async () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      createFinding(
        "WORTH_A_LOOK",
        `look-${i}`,
        "open",
        "Consider improving error handling",
      ),
    );

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.deduplication.duplicatesRemoved).toBe(7);
    expect(result.review.findings).toHaveLength(1);
    expect(result.findingPolicy.omittedWorthALook).toBe(0);
  });

  it("keeps the same generated ID when the AI-provided ID changes", async () => {
    const firstService = createService(
      JSON.stringify({
        ...validAiReview,
        findings: [
          createFinding(
            "BLOCKER",
            "ai-id-001",
            "open",
            "Missing authorization",
          ),
        ],
      }),
    );

    const secondService = createService(
      JSON.stringify({
        ...validAiReview,
        findings: [
          createFinding(
            "BLOCKER",
            "ai-id-999",
            "open",
            "Missing authorization",
          ),
        ],
      }),
    );

    const firstResult = await firstService.review(request);
    const secondResult = await secondService.review(request);

    expect(firstResult.review.findings[0].id).toBe(
      secondResult.review.findings[0].id,
    );
  });

  it("does not change the verdict when duplicate blockers are removed", async () => {
    const findings = [
      createFinding("BLOCKER", "blocker-001", "open", "Missing authorization"),
      createFinding("BLOCKER", "blocker-002", "open", "Missing authorization"),
    ];

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings,
      }),
    );

    const result = await service.review(request);

    expect(result.deduplication.duplicatesRemoved).toBe(1);
    expect(result.verdict.blockerCount).toBe(1);
    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("preserves a previous blocker when the AI omits it", async () => {
    const previousFinding = createFinding(
      "BLOCKER",
      "old-ai-id",
      "open",
      "Missing authorization",
    );

    previousFinding.id = generateFindingId(previousFinding);

    const service = createService(JSON.stringify(validAiReview));

    const result = await service.review(request, [previousFinding]);

    expect(result.review.findings).toHaveLength(1);
    expect(result.review.findings[0].status).toBe("open");
    expect(result.review.findings[0].id).toBe(previousFinding.id);
    expect(result.tracking.unverifiedPreviousFindings).toHaveLength(1);
    expect(result.verdict.blockerCount).toBe(1);
    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("marks a matching current finding as previously reported", async () => {
    const previousFinding = createFinding(
      "BLOCKER",
      "old-ai-id",
      "open",
      "Missing authorization",
    );

    previousFinding.id = generateFindingId(previousFinding);

    const currentFinding = createFinding(
      "BLOCKER",
      "new-ai-id",
      "open",
      "Missing authorization",
    );

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings: [currentFinding],
      }),
    );

    const result = await service.review(request, [previousFinding]);

    expect(result.review.findings).toHaveLength(1);
    expect(result.review.findings[0].occurrence).toBe("previously_reported");
    expect(result.tracking.previouslyReportedCount).toBe(1);
    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("preserves previous blockers while adding newly discovered blockers", async () => {
    const previousFinding = createFinding(
      "BLOCKER",
      "old-ai-id",
      "open",
      "Missing authorization",
    );

    previousFinding.id = generateFindingId(previousFinding);

    const newFinding = createFinding(
      "BLOCKER",
      "new-ai-id",
      "open",
      "Missing input validation",
    );

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings: [newFinding],
      }),
    );

    const result = await service.review(request, [previousFinding]);

    expect(result.review.findings).toHaveLength(2);
    expect(result.verdict.blockerCount).toBe(2);
    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("reopens a previously resolved finding if the AI reports it again", async () => {
    const previousFinding = createFinding(
      "BLOCKER",
      "old-ai-id",
      "resolved",
      "Missing authorization",
    );

    previousFinding.id = generateFindingId(previousFinding);

    const currentFinding = createFinding(
      "BLOCKER",
      "new-ai-id",
      "open",
      "Missing authorization",
    );

    const service = createService(
      JSON.stringify({
        ...validAiReview,
        findings: [currentFinding],
      }),
    );

    const result = await service.review(request, [previousFinding]);

    expect(result.review.findings).toHaveLength(1);
    expect(result.review.findings[0].status).toBe("open");
    expect(result.review.findings[0].id).toBe(previousFinding.id);
    expect(result.review.findings[0].occurrence).toBe("previously_reported");
    expect(result.verdict.blockerCount).toBe(1);
    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("resolves previous findings when their source file is deleted", async () => {
    const previousFinding = createFinding(
      "BLOCKER",
      "deleted-file-blocker",
      "open",
      "Missing authorization",
    );

    previousFinding.file = "src/old-service.ts";
    previousFinding.id = generateFindingId(previousFinding);

    const service = createService(JSON.stringify(validAiReview));

    const result = await service.review(
      request,
      [previousFinding],
      [],
      ["src/old-service.ts"],
    );

    expect(result.review.findings).toHaveLength(1);
    expect(result.review.findings[0]).toMatchObject({
      id: previousFinding.id,
      status: "resolved",
    });

    expect(result.tracking.resolvedByDeletedFileFindings).toHaveLength(1);
    expect(result.tracking.unverifiedPreviousFindings).toHaveLength(0);
    expect(result.verdict.blockerCount).toBe(0);
    expect(result.verdict.verdict).toBe("PASS");
  });

  it("keeps findings open when their source files were not deleted", async () => {
    const previousFinding = createFinding(
      "BLOCKER",
      "retained-file-blocker",
      "open",
      "Missing authorization",
    );

    previousFinding.file = "src/current-service.ts";
    previousFinding.id = generateFindingId(previousFinding);

    const service = createService(JSON.stringify(validAiReview));

    const result = await service.review(
      request,
      [previousFinding],
      [],
      ["src/deleted-service.ts"],
    );

    expect(result.review.findings).toHaveLength(1);
    expect(result.review.findings[0].status).toBe("open");
    expect(result.verdict.blockerCount).toBe(1);
    expect(result.verdict.verdict).toBe("FAIL");
  });
});
