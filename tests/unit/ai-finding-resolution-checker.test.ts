import { describe, expect, it, vi } from "vitest";

import { AiFindingResolutionChecker } from "../../src/review/ai-finding-resolution-checker.js";
import { ReviewService } from "../../src/review/review-service.js";
import type { ReviewFinding } from "../../src/validation/review-result.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const FILE = "src/auth/guard.ts";
const FIXED_SOURCE = `export function canEdit(user: User) {
  if (!user.isAdmin) {
    throw new Error("forbidden");
  }
  return true;
}`;

function previousFinding(): ReviewFinding {
  return {
    id: "finding-001",
    severity: "BLOCKER",
    category: "security",
    file: FILE,
    line: 2,
    title: "Missing authorization check",
    description: "canEdit always returns true.",
    impact: "Anyone can edit.",
    suggested_fix: "Check user.isAdmin.",
    evidence: "return true",
    occurrence: "new",
    status: "open",
  };
}

function checker(
  responseJson: unknown,
  files = new Map([[FILE, FIXED_SOURCE]]),
) {
  const gateway = {
    review: vi.fn().mockResolvedValue({
      content: JSON.stringify(responseJson),
      provider: "test",
      model: "test",
    }),
  };

  return {
    gateway,
    checker: new AiFindingResolutionChecker(gateway, async () => files),
  };
}

const input = () => ({
  repository: "o/r",
  pullRequestNumber: 1,
  baseSha: BASE,
  headSha: HEAD,
  findings: [previousFinding()],
});

describe("AiFindingResolutionChecker", () => {
  it("resolves when the quote really exists in the current file", async () => {
    const { checker: c } = checker({
      resolutions: [
        {
          finding_id: "finding-001",
          decision: "CONFIRMED_FIXED",
          reasoning: "Guard added.",
          fixed_code_quote:
            'if (!user.isAdmin) {\n    throw new Error("forbidden");',
        },
      ],
    });

    expect((await c.check(input())).map((r) => r.findingId)).toEqual([
      "finding-001",
    ]);
  });

  it("rejects a hallucinated quote that is not in the file", async () => {
    const { checker: c } = checker({
      resolutions: [
        {
          finding_id: "finding-001",
          decision: "CONFIRMED_FIXED",
          reasoning: "Fixed.",
          fixed_code_quote: "if (!hasPermission(user)) throw new Error()",
        },
      ],
    });

    expect(await c.check(input())).toEqual([]);
  });

  it("does not resolve STILL_PRESENT or UNVERIFIED", async () => {
    for (const decision of ["STILL_PRESENT", "UNVERIFIED"]) {
      const { checker: c } = checker({
        resolutions: [
          {
            finding_id: "finding-001",
            decision,
            reasoning: "x",
            fixed_code_quote: "",
          },
        ],
      });

      expect(await c.check(input())).toEqual([]);
    }
  });

  it("fails closed on invalid JSON or unknown ids", async () => {
    const bad = new AiFindingResolutionChecker(
      {
        review: vi
          .fn()
          .mockResolvedValue({
            content: "not json",
            provider: "t",
            model: "t",
          }),
      },
      async () => new Map([[FILE, FIXED_SOURCE]]),
    );

    expect(await bad.check(input())).toEqual([]);

    const { checker: unknown } = checker({
      resolutions: [
        {
          finding_id: "other",
          decision: "CONFIRMED_FIXED",
          reasoning: "x",
          fixed_code_quote: "if (!user.isAdmin) {",
        },
      ],
    });

    expect(await unknown.check(input())).toEqual([]);
  });

  it("skips the AI call when the file cannot be loaded", async () => {
    const { checker: c, gateway } = checker({ resolutions: [] }, new Map());

    expect(await c.check(input())).toEqual([]);
    expect(gateway.review).not.toHaveBeenCalled();
  });
});

describe("ReviewService with resolution checker", () => {
  const request = {
    requestId: "r",
    repository: "o/r",
    pullRequestNumber: 1,
    baseSha: BASE,
    headSha: HEAD,
    systemPrompt: "s",
    userPrompt: "u",
    maxTokens: 8192,
  };

  function service(
    reviewComplete: boolean,
    resolved: string[],
    throws = false,
  ) {
    const gateway = {
      review: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          commit_sha: HEAD,
          verdict: "PASS",
          summary: "ok",
          findings: [],
          sensitive_categories: [],
          review_complete: reviewComplete,
        }),
        provider: "t",
        model: "t",
      }),
    };

    const resolutionChecker = {
      check: throws
        ? vi.fn().mockRejectedValue(new Error("boom"))
        : vi.fn().mockResolvedValue(
            resolved.map((findingId) => ({
              findingId,
              reasoning: "r",
              fixedCodeQuote: "q",
            })),
          ),
    };

    return {
      resolutionChecker,
      svc: new ReviewService(gateway as never, resolutionChecker),
    };
  }

  it("marks a fixed finding resolved and the gate passes", async () => {
    const { svc } = service(true, ["finding-001"]);
    const result = await svc.review(request, [previousFinding()]);

    expect(result.review.findings[0].status).toBe("resolved");
    expect(result.verdict.verdict).toBe("PASS");
  });

  it("keeps the finding open (FAIL) when the checker confirms nothing", async () => {
    const { svc } = service(true, []);
    const result = await svc.review(request, [previousFinding()]);

    expect(result.review.findings[0].status).toBe("open");
    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("keeps findings open when the checker throws", async () => {
    const { svc } = service(true, [], true);
    const result = await svc.review(request, [previousFinding()]);

    expect(result.verdict.verdict).toBe("FAIL");
  });

  it("does not run the checker when the review is incomplete", async () => {
    const { svc, resolutionChecker } = service(false, ["finding-001"]);
    await svc.review(request, [previousFinding()]);

    expect(resolutionChecker.check).not.toHaveBeenCalled();
  });
});
