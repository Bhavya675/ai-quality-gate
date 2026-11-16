import type { ChangedFile } from "./pull-request-service.js";
import type { ReviewFinding } from "../validation/review-result.js";

const FINDING_MARKER_PREFIX = "<!-- AI_QUALITY_GATE_FINDING:";
const MAX_NEAREST_LINE_DISTANCE = 3;
const MAX_RANGE_LINES = 30;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const SEVERITY_ICON = {
  BLOCKER: "🔴",
  WORTH_A_LOOK: "👀",
  NIT: "🧹",
} as const;

export interface ReviewCommentApi {
  rest: {
    pulls: {
      listReviewComments(p: Record<string, unknown>): Promise<{
        data: Array<{
          id: number;
          body?: string | null;
          html_url?: string;
          user?: { type?: string } | null;
        }>;
      }>;
      createReviewComment(p: Record<string, unknown>): Promise<{
        data: { id: number; html_url: string };
      }>;
      updateReviewComment(p: Record<string, unknown>): Promise<unknown>;
      createReplyForReviewComment(p: Record<string, unknown>): Promise<unknown>;
    };
  };
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface InlineSyncInput {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  files: ChangedFile[];
  findings: ReviewFinding[];
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/** RIGHT-side line numbers that exist in a unified-diff patch. */
export function getCommentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();

  if (!patch) {
    return lines;
  }

  let newLine = 0;

  for (const row of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);

    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (newLine === 0 || row.startsWith("\\")) {
      continue;
    }

    if (row.startsWith("+") || row.startsWith(" ")) {
      lines.add(newLine++);
    }
  }

  return lines;
}

/** `file` = anchor on the file itself when the exact line is not in the diff. */
export type CommentTarget =
  | { kind: "line"; line: number; startLine?: number }
  | { kind: "file" };

export function resolveCommentTarget(
  finding: Pick<ReviewFinding, "line" | "end_line">,
  commentable: Set<number>,
): CommentTarget {
  if (commentable.size === 0) {
    return { kind: "file" };
  }

  const end = finding.end_line ?? finding.line;

  if (end > finding.line && end - finding.line <= MAX_RANGE_LINES) {
    let allInDiff = true;

    for (let n = finding.line; n <= end; n++) {
      if (!commentable.has(n)) {
        allInDiff = false;
        break;
      }
    }

    if (allInDiff) {
      return { kind: "line", startLine: finding.line, line: end };
    }
  }

  if (commentable.has(finding.line)) {
    return { kind: "line", line: finding.line };
  }

  let nearest: number | null = null;

  for (const n of commentable) {
    if (
      Math.abs(n - finding.line) <= MAX_NEAREST_LINE_DISTANCE &&
      (nearest === null ||
        Math.abs(n - finding.line) < Math.abs(nearest - finding.line))
    ) {
      nearest = n;
    }
  }

  return nearest === null ? { kind: "file" } : { kind: "line", line: nearest };
}

function clean(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b")
    .trim();
}

export function renderInlineBody(
  finding: ReviewFinding,
  fileLevel = false,
): string {
  return [
    `${FINDING_MARKER_PREFIX}${finding.id} -->`,
    `${SEVERITY_ICON[finding.severity]} **${clean(finding.title)}**`,
    ...(fileLevel
      ? [
          "",
          `📍 Applies to \`${clean(finding.file).replace(/`/g, "")}:${finding.line}\`, which is not part of the changed lines.`,
        ]
      : []),
    "",
    "<details open>",
    "<summary>Finding detail</summary>",
    "",
    clean(finding.description),
    "",
    `**Impact:** ${clean(finding.impact)}`,
    "",
    `**Suggested fix:** ${clean(finding.suggested_fix)}`,
    "",
    "</details>",
  ].join("\n");
}

function extractFindingId(body: string | null | undefined): string | null {
  if (!body?.startsWith(FINDING_MARKER_PREFIX)) {
    return null;
  }

  const end = body.indexOf(" -->");
  const id = body.slice(FINDING_MARKER_PREFIX.length, end);

  return end > 0 && ID_PATTERN.test(id) ? id : null;
}

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) { nodes { databaseId } }
        }
      }
    }
  }
}`;

interface ThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: { nodes: Array<{ databaseId: number | null }> };
        }>;
      };
    };
  };
}

/**
 * Publishes one inline review comment per open finding (once), and resolves
 * the thread when its finding is resolved. Never throws for per-comment
 * failures: the summary comment remains the source of truth.
 */
export class InlineReviewCommentPublisher {
  constructor(private readonly github: ReviewCommentApi) {}

  /** Returns finding id -> html_url of its inline comment. */
  async sync(input: InlineSyncInput): Promise<Map<string, string>> {
    const urls = new Map<string, string>();

    const existing = await this.listExisting(input);
    const threads = await this.listThreads(input);

    const patchByPath = new Map(
      input.files.map((f) => [normalizePath(f.filename), f.patch]),
    );

    for (const finding of input.findings) {
      const prior = existing.get(finding.id);
      const thread = prior ? threads.get(prior.id) : undefined;

      if (finding.status === "resolved") {
        if (prior && thread && !thread.isResolved) {
          await this.safely("resolve thread", async () => {
            await this.github.rest.pulls.createReplyForReviewComment({
              owner: input.owner,
              repo: input.repository,
              pull_number: input.pullRequestNumber,
              comment_id: prior.id,
              body: `✅ Fixed as of \`${input.headSha.slice(0, 7)}\`.`,
            });
            await this.github.graphql(
              "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }",
              { id: thread.id },
            );
          });
        }

        continue;
      }

      const patchKnown = patchByPath.has(normalizePath(finding.file));
      const target = patchKnown
        ? resolveCommentTarget(
            finding,
            getCommentableLines(patchByPath.get(normalizePath(finding.file))),
          )
        : null;

      const body = renderInlineBody(finding, target?.kind === "file");

      if (prior) {
        urls.set(finding.id, prior.url);

        if (prior.body !== body) {
          await this.safely("update comment", () =>
            this.github.rest.pulls.updateReviewComment({
              owner: input.owner,
              repo: input.repository,
              comment_id: prior.id,
              body,
            }),
          );
        }

        if (thread?.isResolved) {
          await this.safely("reopen thread", () =>
            this.github.graphql(
              "mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id } } }",
              { id: thread.id },
            ),
          );
        }

        continue;
      }

      if (!target) {
        continue; // File not in the PR: still listed in the summary comment.
      }

      await this.safely("create comment", async () => {
        const created = await this.github.rest.pulls.createReviewComment({
          owner: input.owner,
          repo: input.repository,
          pull_number: input.pullRequestNumber,
          commit_id: input.headSha,
          path: normalizePath(finding.file),
          ...(target.kind === "file"
            ? { subject_type: "file" }
            : {
                side: "RIGHT",
                line: target.line,
                ...(target.startLine
                  ? { start_line: target.startLine, start_side: "RIGHT" }
                  : {}),
              }),
          body,
        });

        urls.set(finding.id, created.data.html_url);
      });
    }

    return urls;
  }

  private async listExisting(input: InlineSyncInput) {
    const found = new Map<
      string,
      { id: number; url: string; body: string }
    >();

    for (let page = 1; page <= 10; page++) {
      const response = await this.github.rest.pulls.listReviewComments({
        owner: input.owner,
        repo: input.repository,
        pull_number: input.pullRequestNumber,
        per_page: 100,
        page,
      });

      for (const comment of response.data) {
        const id = extractFindingId(comment.body);

        if (id && comment.user?.type === "Bot" && !found.has(id)) {
          found.set(id, {
            id: comment.id,
            url: comment.html_url ?? "",
            body: comment.body ?? "",
          });
        }
      }

      if (response.data.length < 100) {
        break;
      }
    }

    return found;
  }

  private async listThreads(input: InlineSyncInput) {
    const threads = new Map<number, { id: string; isResolved: boolean }>();
    let cursor: string | null = null;

    try {
      for (let page = 0; page < 5; page++) {
        const data: ThreadsResponse = await this.github.graphql<ThreadsResponse>(
          THREADS_QUERY,
          {
            owner: input.owner,
            repo: input.repository,
            number: input.pullRequestNumber,
            cursor,
          },
        );

        const connection = data.repository.pullRequest.reviewThreads;

        for (const node of connection.nodes) {
          const first = node.comments.nodes[0]?.databaseId;

          if (first != null) {
            threads.set(first, { id: node.id, isResolved: node.isResolved });
          }
        }

        if (!connection.pageInfo.hasNextPage) {
          break;
        }

        cursor = connection.pageInfo.endCursor;
      }
    } catch (error) {
      console.warn(
        "[InlineReviewComments] Unable to list review threads:",
        error instanceof Error ? error.message : "unknown error",
      );
    }

    return threads;
  }

  private async safely(action: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.warn(
        `[InlineReviewComments] ${action} failed:`,
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }
}
