import { describe, expect, it } from "vitest";

import {
  buildFileUrl,
  renderResultComment,
  RESULT_MARKER,
} from "../../src/github/result-comment-renderer.js";
import type { ReviewFinding } from "../../src/validation/review-result.js";

const HEAD = "f4427eb" + "0".repeat(33);

function finding(over: Partial<ReviewFinding>): ReviewFinding {
  return {
    id: "id1",
    severity: "BLOCKER",
    category: "correctness",
    file: "Source Code/App/Stored Procedures/Save.sql",
    line: 137,
    title: "Questions are unanswered",
    description: "d",
    impact: "i",
    suggested_fix: "f",
    evidence: "e",
    occurrence: "new",
    status: "open",
    ...over,
  };
}

const base = {
  verdict: "FAIL" as const,
  summary: "Not yet.",
  reviewComplete: true,
  headSha: HEAD,
  sensitiveCategories: ["money-movement"],
  serverUrl: "https://github.com",
  owner: "o",
  repository: "r",
  workflowRunUrl: "https://github.com/o/r/actions/runs/9",
};

describe("renderResultComment", () => {
  it("groups findings, links files and shows the footer", () => {
    const body = renderResultComment({
      ...base,
      findings: [
        finding({ id: "a", end_line: 140 }),
        finding({ id: "b", severity: "WORTH_A_LOOK", title: "Fee never zero", line: 43 }),
        finding({ id: "c", severity: "NIT", title: "Naming" }),
        finding({ id: "d", status: "resolved", title: "Old issue" }),
      ],
      inlineCommentUrls: new Map([["a", "https://github.com/o/r/pull/1#discussion_r1"]]),
    });

    expect(body.startsWith(RESULT_MARKER)).toBe(true);
    expect(body).toContain("❌ AI quality gate: not ready to merge");
    expect(body).toContain("### 🛑 Must fix before merge");
    expect(body).toContain("### 👀 Worth a look");
    expect(body).toContain("🧹 1 nit</summary>");
    expect(body).toContain("✅ 1 resolved");
    // The link opens the comment on the Conversation tab; ↗ on Files changed.
    expect(body).toContain(
      "[`Source Code/App/Stored Procedures/Save.sql:137`](https://github.com/o/r/pull/1#discussion_r1)",
    );
    expect(body).toContain("[↗](https://github.com/o/r/pull/1/files#r1)");
    // No inline comment (finding "b"): the link falls back to the file.
    expect(body).toContain(`(https://github.com/o/r/blob/${HEAD}/Source%20Code/App/Stored%20Procedures/Save.sql#L43)`);
    expect(body).toContain("[Workflow run](https://github.com/o/r/actions/runs/9)");
    expect(body).toContain("reviewed `f4427eb`");
    expect(body).toContain("sensitive: money-movement");
  });

  it("shows the ready state and category row", () => {
    const body = renderResultComment({
      ...base,
      verdict: "PASS",
      findings: [finding({ severity: "WORTH_A_LOOK", category: "testing", title: "No test" })],
    });

    expect(body).toContain("✅ AI quality gate: ready to merge");
    expect(body).toContain("⚠️ Tests: No test");
    expect(body).toContain("✅ Reviews");
    expect(body).not.toContain("Must fix");
  });

  it("neutralises HTML and mentions in AI text", () => {
    const body = renderResultComment({
      ...base,
      findings: [finding({ title: "<img src=x> ping @octocat" })],
    });

    expect(body).not.toContain("<img");
    expect(body).not.toContain("@octocat");
  });

  it("builds single-line anchors", () => {
    expect(
      buildFileUrl({ ...base }, { file: "a/b.ts", line: 5 }),
    ).toBe(`https://github.com/o/r/blob/${HEAD}/a/b.ts#L5`);
  });
});
