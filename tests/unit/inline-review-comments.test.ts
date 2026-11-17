import { describe, expect, it, vi } from "vitest";

import {
  getCommentableLines,
  InlineReviewCommentPublisher,
  renderInlineBody,
  renderResolvedReply,
  resolveCommentTarget,
  selectFixDiff,
  toFilesTabUrl,
} from "../../src/github/inline-review-comments.js";
import type { ReviewFinding } from "../../src/validation/review-result.js";

const PATCH = [
  "@@ -10,4 +10,5 @@ ctx",
  " keep10",
  "-old11",
  "+new11",
  "+new12",
  " keep13",
  "\\ No newline at end of file",
].join("\n");

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "abc123",
    severity: "BLOCKER",
    category: "correctness",
    file: "src/a.ts",
    line: 11,
    title: "Bug",
    description: "desc",
    impact: "imp",
    suggested_fix: "fix",
    evidence: "e",
    occurrence: "new",
    status: "open",
    ...over,
  };
}

function api(existing: unknown[] = [], threads: unknown[] = []) {
  return {
    rest: {
      pulls: {
        listReviewComments: vi.fn().mockResolvedValue({ data: existing }),
        createReviewComment: vi
          .fn()
          .mockResolvedValue({ data: { id: 7, html_url: "https://x/r7" } }),
        updateReviewComment: vi.fn().mockResolvedValue({}),
        deleteReviewComment: vi.fn().mockResolvedValue({}),
        createReplyForReviewComment: vi.fn().mockResolvedValue({}),
      },
      repos: {
        compareCommitsWithBasehead: vi
          .fn()
          .mockResolvedValue({ data: { files: [] } }),
      },
    },
    graphql: vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads,
          },
        },
      },
    }),
  };
}

const input = (findings: ReviewFinding[]) => ({
  owner: "o",
  repository: "r",
  pullRequestNumber: 1,
  headSha: "b".repeat(40),
  files: [
    {
      filename: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: PATCH,
    },
  ],
  findings,
});

describe("diff line helpers", () => {
  it("collects RIGHT-side lines only", () => {
    expect([...getCommentableLines(PATCH)]).toEqual([10, 11, 12, 13]);
    expect(getCommentableLines(undefined).size).toBe(0);
  });

  it("targets exact, range, nearest and none", () => {
    const set = getCommentableLines(PATCH);

    expect(resolveCommentTarget({ line: 11 }, set)).toEqual({
      kind: "line",
      line: 11,
    });
    expect(resolveCommentTarget({ line: 10, end_line: 12 }, set)).toEqual({
      kind: "line",
      startLine: 10,
      line: 12,
    });
    // within 3 lines of the diff: nearest diff line
    expect(resolveCommentTarget({ line: 15 }, set)).toEqual({
      kind: "line",
      line: 13,
    });
    // far from the changed lines: file-level, never a misleading line
    expect(resolveCommentTarget({ line: 48 }, set)).toEqual({ kind: "file" });
    expect(resolveCommentTarget({ line: 5 }, new Set())).toEqual({
      kind: "file",
    });
  });
});

describe("InlineReviewCommentPublisher", () => {
  it("creates one comment per open finding with a marker", async () => {
    const github = api();
    const urls = await new InlineReviewCommentPublisher(github).sync(
      input([finding()]),
    );

    const call = github.rest.pulls.createReviewComment.mock.calls[0][0];
    expect(call.path).toBe("src/a.ts");
    expect(call.line).toBe(11);
    expect(call.side).toBe("RIGHT");
    expect(call.body).toContain("<!-- AI_QUALITY_GATE_FINDING:abc123 -->");
    expect(call.body).toContain("Finding detail");
    expect(urls.get("abc123")).toBe("https://x/r7");
  });

  it("links the summary to the Files changed anchor, which expands collapsed threads", async () => {
    const github = api();
    github.rest.pulls.createReviewComment.mockResolvedValue({
      data: { id: 9, html_url: "https://github.com/o/r/pull/2#discussion_r99" },
    });

    const urls = await new InlineReviewCommentPublisher(github).sync(
      input([finding()]),
    );

    expect(urls.get("abc123")).toBe("https://github.com/o/r/pull/2/files#r99");
  });

  it("does not duplicate a comment that already exists", async () => {
    const f = finding();
    const github = api([
      {
        id: 5,
        body: renderInlineBody(f),
        html_url: "https://x/r5",
        user: { type: "Bot" },
      },
    ]);

    const urls = await new InlineReviewCommentPublisher(github).sync(
      input([f]),
    );

    expect(github.rest.pulls.createReviewComment).not.toHaveBeenCalled();
    expect(github.rest.pulls.updateReviewComment).not.toHaveBeenCalled();
    expect(urls.get("abc123")).toBe("https://x/r5");
  });

  it("ignores a spoofed marker from a non-bot user", async () => {
    const github = api([
      {
        id: 5,
        body: renderInlineBody(finding()),
        html_url: "https://x/r5",
        user: { type: "User" },
      },
    ]);

    await new InlineReviewCommentPublisher(github).sync(input([finding()]));

    expect(github.rest.pulls.createReviewComment).toHaveBeenCalledTimes(1);
  });

  it("resolves the thread when the finding is resolved", async () => {
    const f = finding({ status: "resolved" });
    const github = api(
      [
        {
          id: 5,
          body: renderInlineBody(f),
          html_url: "u",
          user: { type: "Bot" },
        },
      ],
      [
        {
          id: "T1",
          isResolved: false,
          comments: { nodes: [{ databaseId: 5 }] },
        },
      ],
    );

    await new InlineReviewCommentPublisher(github).sync(input([f]));

    expect(github.rest.pulls.createReplyForReviewComment).toHaveBeenCalledTimes(
      1,
    );
    const mutation = github.graphql.mock.calls.find((c) =>
      String(c[0]).includes("resolveReviewThread"),
    );
    expect(mutation?.[1]).toEqual({ id: "T1" });
  });

  it("reopens a resolved thread when the finding returns", async () => {
    const f = finding();
    const github = api(
      [
        {
          id: 5,
          body: renderInlineBody(f),
          html_url: "u",
          user: { type: "Bot" },
        },
      ],
      [
        {
          id: "T1",
          isResolved: true,
          comments: { nodes: [{ databaseId: 5 }] },
        },
      ],
    );

    await new InlineReviewCommentPublisher(github).sync(input([f]));

    expect(
      github.graphql.mock.calls.some((c) =>
        String(c[0]).includes("unresolveReviewThread"),
      ),
    ).toBe(true);
  });

  describe("relocating a comment whose finding line changed", () => {
    const botComment = (over: Record<string, unknown> = {}) => ({
      id: 5,
      body: renderInlineBody(finding()),
      html_url: "https://x/r5",
      user: { type: "Bot" },
      line: 10,
      start_line: null,
      subject_type: "line",
      ...over,
    });

    it("creates the new comment, then deletes the stale one", async () => {
      const github = api([botComment()]); // old anchor 10, finding now at 11

      const urls = await new InlineReviewCommentPublisher(github).sync(
        input([finding({ line: 11 })]),
      );

      const create = github.rest.pulls.createReviewComment.mock.calls[0][0];
      expect(create.line).toBe(11);
      expect(github.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 5 }),
      );
      expect(urls.get("abc123")).toBe("https://x/r7");
    });

    it("relocates an outdated comment (line is null)", async () => {
      const github = api([botComment({ line: null })]);

      await new InlineReviewCommentPublisher(github).sync(input([finding()]));

      expect(github.rest.pulls.createReviewComment).toHaveBeenCalledTimes(1);
      expect(github.rest.pulls.deleteReviewComment).toHaveBeenCalledTimes(1);
    });

    it("leaves a correctly placed comment alone", async () => {
      const github = api([botComment({ line: 11 })]);

      const urls = await new InlineReviewCommentPublisher(github).sync(
        input([finding()]),
      );

      expect(github.rest.pulls.createReviewComment).not.toHaveBeenCalled();
      expect(github.rest.pulls.deleteReviewComment).not.toHaveBeenCalled();
      expect(urls.get("abc123")).toBe("https://x/r5");
    });

    it("keeps the comment when people replied to it", async () => {
      const github = api([
        botComment(),
        {
          id: 6,
          body: "I disagree",
          user: { type: "User" },
          in_reply_to_id: 5,
        },
      ]);

      const urls = await new InlineReviewCommentPublisher(github).sync(
        input([finding({ line: 11 })]),
      );

      expect(github.rest.pulls.createReviewComment).not.toHaveBeenCalled();
      expect(github.rest.pulls.deleteReviewComment).not.toHaveBeenCalled();
      expect(urls.get("abc123")).toBe("https://x/r5");
    });

    it("keeps the old comment when creating the new one fails", async () => {
      const github = api([botComment()]);
      github.rest.pulls.createReviewComment.mockRejectedValue(new Error("422"));

      const urls = await new InlineReviewCommentPublisher(github).sync(
        input([finding({ line: 11 })]),
      );

      expect(github.rest.pulls.deleteReviewComment).not.toHaveBeenCalled();
      expect(urls.get("abc123")).toBe("https://x/r5");
    });
  });

  it("anchors on the file when the line is outside the diff", async () => {
    const github = api();

    await new InlineReviewCommentPublisher(github).sync(
      input([finding({ line: 48 })]),
    );

    const call = github.rest.pulls.createReviewComment.mock.calls[0][0];
    expect(call.subject_type).toBe("file");
    expect(call.line).toBeUndefined();
    expect(call.body).toContain("src/a.ts:48");
    expect(
      call.body.startsWith("<!-- AI_QUALITY_GATE_FINDING:abc123 -->"),
    ).toBe(true);
  });

  it("skips files that are not in the PR and survives API errors", async () => {
    const github = api();
    github.rest.pulls.createReviewComment.mockRejectedValue(new Error("422"));

    const urls = await new InlineReviewCommentPublisher(github).sync(
      input([
        finding({ file: "other/not-in-pr.ts" }),
        finding({ id: "zzz", line: 12 }),
      ]),
    );

    expect(github.rest.pulls.createReviewComment).toHaveBeenCalledTimes(1);
    expect(urls.size).toBe(0);
  });
});

describe("fix diff on resolve", () => {
  const OLD_PATCH = [
    "@@ -5,3 +5,3 @@ fn",
    " keep",
    "-  return fetch(url);",
    "+  return http.get(url);",
    " keep",
    "@@ -200,2 +200,2 @@ far",
    "-a",
    "+b",
  ].join("\n");

  it("toFilesTabUrl rewrites discussion links only", () => {
    expect(toFilesTabUrl("https://github.com/o/r/pull/2#discussion_r5")).toBe(
      "https://github.com/o/r/pull/2/files#r5",
    );
    expect(toFilesTabUrl("https://x/r5")).toBe("https://x/r5");
  });

  it("selects the hunk around the old line", () => {
    const diff = selectFixDiff(OLD_PATCH, 6) as string;
    expect(diff).toContain("-  return fetch(url);");
    expect(diff).not.toContain("far");
  });

  it("falls back to the first hunk and truncates long diffs", () => {
    expect(selectFixDiff(OLD_PATCH, undefined)).toContain("return http.get");
    const long = ["@@ -1,100 +1,100 @@", ...Array(100).fill("+x")].join("\n");
    expect(selectFixDiff(long, 1, 10)).toContain("diff truncated");
    expect(selectFixDiff("no hunks here", 1)).toBeNull();
  });

  it("uses a longer fence when the diff contains backticks", () => {
    const body = renderResolvedReply("b".repeat(40), "+ const a = ```x```;");
    expect(body).toContain("````diff");
    expect(body).toContain("Changes that fixed it");
    expect(renderResolvedReply("b".repeat(40), null)).not.toContain("<details");
  });

  const resolvedSetup = (compare: unknown) => {
    const f = finding({ status: "resolved" });
    const github = api(
      [
        {
          id: 5,
          body: renderInlineBody(f),
          html_url: "u",
          user: { type: "Bot" },
          original_commit_id: "c".repeat(40),
          original_line: 6,
        },
      ],
      [
        {
          id: "T1",
          isResolved: false,
          comments: { nodes: [{ databaseId: 5 }] },
        },
      ],
    );
    github.rest.repos.compareCommitsWithBasehead = compare as never;
    return { f, github };
  };

  it("posts the code change in the resolve reply", async () => {
    const { f, github } = resolvedSetup(
      vi.fn().mockResolvedValue({
        data: { files: [{ filename: "src/a.ts", patch: OLD_PATCH }] },
      }),
    );

    await new InlineReviewCommentPublisher(github).sync(input([f]));

    const reply =
      github.rest.pulls.createReplyForReviewComment.mock.calls[0][0];
    expect(reply.body).toContain("Resolved");
    expect(reply.body).toContain("```diff");
    expect(reply.body).toContain("+  return http.get(url);");
    expect(github.rest.pulls.createReplyForReviewComment).toHaveBeenCalledTimes(
      1,
    );
  });

  it("still resolves with a plain reply when the compare call fails", async () => {
    const { f, github } = resolvedSetup(
      vi.fn().mockRejectedValue(new Error("boom")),
    );

    await new InlineReviewCommentPublisher(github).sync(input([f]));

    const reply =
      github.rest.pulls.createReplyForReviewComment.mock.calls[0][0];
    expect(reply.body).not.toContain("```diff");
    expect(
      github.graphql.mock.calls.some((c) =>
        String(c[0]).includes("resolveReviewThread"),
      ),
    ).toBe(true);
  });
});
