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
          line?: number | null;
          start_line?: number | null;
          subject_type?: string | null;
          in_reply_to_id?: number;
          original_line?: number | null;
          original_commit_id?: string | null;
        }>;
      }>;
      createReviewComment(p: Record<string, unknown>): Promise<{
        data: { id: number; html_url: string };
      }>;
      updateReviewComment(p: Record<string, unknown>): Promise<unknown>;
      deleteReviewComment(p: Record<string, unknown>): Promise<unknown>;
      createReplyForReviewComment(p: Record<string, unknown>): Promise<unknown>;
    };
    repos: {
      compareCommitsWithBasehead(p: Record<string, unknown>): Promise<{
        data: { files?: Array<{ filename: string; patch?: string }> };
      }>;
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

/**
 * `/files#r<id>` expands the diff and the thread even when the thread is
 * collapsed (resolved, outdated or viewed). `#discussion_r<id>` on the
 * conversation tab does not always expand it.
 */
export function toFilesTabUrl(htmlUrl: string): string {
  return htmlUrl.replace(/\/pull\/(\d+)#discussion_r(\d+)$/, "/pull/$1/files#r$2");
}

interface Hunk {
  header: string;
  oldStart: number;
  oldLength: number;
  lines: string[];
}

function splitHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];

  for (const row of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(row);

    if (header) {
      hunks.push({
        header: row,
        oldStart: Number(header[1]),
        oldLength: header[2] === undefined ? 1 : Number(header[2]),
        lines: [],
      });
    } else if (hunks.length > 0) {
      hunks[hunks.length - 1].lines.push(row);
    }
  }

  return hunks;
}

const FIX_HUNK_WINDOW = 10;
const FIX_NEAREST_HUNK_DISTANCE = 50;
const FIX_DIFF_MAX_LINES = 60;

/** The part of a file's compare-patch that changed around the old line. */
export function selectFixDiff(
  patch: string,
  oldLine: number | null | undefined,
  maxLines = FIX_DIFF_MAX_LINES,
): string | null {
  const hunks = splitHunks(patch);

  if (hunks.length === 0) {
    return null;
  }

  const distance = (hunk: Hunk, line: number) => {
    const end = hunk.oldStart + Math.max(hunk.oldLength, 1) - 1;
    return line < hunk.oldStart ? hunk.oldStart - line : line > end ? line - end : 0;
  };

  let chosen: Hunk[] = [];

  if (oldLine != null) {
    chosen = hunks.filter((hunk) => distance(hunk, oldLine) <= FIX_HUNK_WINDOW);

    if (chosen.length === 0) {
      const nearest = hunks.reduce((a, b) =>
        distance(b, oldLine) < distance(a, oldLine) ? b : a,
      );

      if (distance(nearest, oldLine) <= FIX_NEAREST_HUNK_DISTANCE) {
        chosen = [nearest];
      }
    }
  }

  if (chosen.length === 0) {
    chosen = [hunks[0]];
  }

  const rows = chosen.flatMap((hunk) => [hunk.header, ...hunk.lines]);

  while (rows.length > 0 && rows[rows.length - 1].trim() === "") {
    rows.pop();
  }

  return rows.length > maxLines
    ? [...rows.slice(0, maxLines), "… (diff truncated)"].join("\n")
    : rows.join("\n");
}

export function renderResolvedReply(headSha: string, diff: string | null): string {
  const lines = [`✅ **Resolved** in \`${headSha.slice(0, 7)}\`.`];

  if (diff) {
    const longestRun = Math.max(
      0,
      ...[...diff.matchAll(/`+/g)].map((match) => match[0].length),
    );
    const fence = "`".repeat(Math.max(3, longestRun + 1));

    lines.push(
      "",
      "<details open>",
      "<summary>Changes that fixed it</summary>",
      "",
      `${fence}diff`,
      diff,
      fence,
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}

interface ExistingComment {
  id: number;
  url: string;
  body: string;
  /** undefined = unknown, null = outdated (no longer on the current diff) */
  line?: number | null;
  startLine?: number | null;
  subjectType?: string | null;
  originalLine?: number | null;
  originalCommitId?: string | null;
  replies: number;
}

function isAnchoredAt(prior: ExistingComment, target: CommentTarget): boolean {
  if (prior.subjectType === "file") {
    return target.kind === "file";
  }

  if (prior.line === undefined) {
    return true; // Unknown position: do not move it.
  }

  if (prior.line === null || target.kind !== "line") {
    return false;
  }

  return (
    prior.line === target.line &&
    (prior.startLine ?? null) === (target.startLine ?? null)
  );
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
          isOutdated
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
          isOutdated: boolean;
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
            const diff = await this.buildFixDiff(input, prior, finding);

            await this.github.rest.pulls.createReplyForReviewComment({
              owner: input.owner,
              repo: input.repository,
              pull_number: input.pullRequestNumber,
              comment_id: prior.id,
              body: renderResolvedReply(input.headSha, diff),
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
        // The finding is still open, so its thread must be open. GitHub
        // collapses a thread only when it is resolved or outdated.
        let reopened = thread?.isResolved === true;

        if (thread && reopened) {
          reopened = !(await this.safely("reopen thread", () =>
            this.github.graphql(
              "mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id } } }",
              { id: thread.id },
            ),
          ));
        }

        const outdated = thread?.isOutdated === true || prior.line === null;
        const misplaced = target ? !isAnchoredAt(prior, target) || outdated : false;

        // A comment cannot be moved, so a misplaced or outdated one is
        // replaced on the current diff. An outdated thread people replied to
        // is kept as history, and a fresh open comment is added next to it.
        if (target && misplaced && (prior.replies === 0 || outdated)) {
          const createdUrl = await this.createComment(input, finding, target, body);

          if (createdUrl) {
            if (prior.replies === 0) {
              await this.safely("delete outdated comment", () =>
                this.github.rest.pulls.deleteReviewComment({
                  owner: input.owner,
                  repo: input.repository,
                  comment_id: prior.id,
                }),
              );
            }

            urls.set(finding.id, createdUrl);
            continue;
          }
        }

        if (outdated || reopened) {
          console.warn(
            `[InlineReviewComments] Thread for finding ${finding.id} may still be collapsed in GitHub (outdated or still resolved).`,
          );
        }

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

        continue;
      }

      if (!target) {
        continue; // File not in the PR: still listed in the summary comment.
      }

      const createdUrl = await this.createComment(input, finding, target, body);

      if (createdUrl) {
        urls.set(finding.id, createdUrl);
      }
    }

    return urls;
  }

  private async listExisting(input: InlineSyncInput) {
    const found = new Map<string, ExistingComment>();
    const replyCounts = new Map<number, number>();

    for (let page = 1; page <= 10; page++) {
      const response = await this.github.rest.pulls.listReviewComments({
        owner: input.owner,
        repo: input.repository,
        pull_number: input.pullRequestNumber,
        per_page: 100,
        page,
      });

      for (const comment of response.data) {
        if (comment.in_reply_to_id !== undefined) {
          replyCounts.set(
            comment.in_reply_to_id,
            (replyCounts.get(comment.in_reply_to_id) ?? 0) + 1,
          );
        }

        const id = extractFindingId(comment.body);

        if (id && comment.user?.type === "Bot") {
          // Listed oldest first: the newest comment for a finding wins.
          found.set(id, {
            id: comment.id,
            url: comment.html_url ?? "",
            body: comment.body ?? "",
            line: comment.line,
            startLine: comment.start_line,
            subjectType: comment.subject_type,
            originalLine: comment.original_line,
            originalCommitId: comment.original_commit_id,
            replies: 0,
          });
        }
      }

      if (response.data.length < 100) {
        break;
      }
    }

    for (const comment of found.values()) {
      comment.replies = replyCounts.get(comment.id) ?? 0;
    }

    return found;
  }

  /** Diff of what changed around the finding since the comment was made. */
  private async buildFixDiff(
    input: InlineSyncInput,
    prior: ExistingComment,
    finding: ReviewFinding,
  ): Promise<string | null> {
    const base = prior.originalCommitId;

    if (!base || base === input.headSha) {
      return null;
    }

    try {
      const path = normalizePath(finding.file);

      for (let page = 1; page <= 5; page++) {
        const response = await this.github.rest.repos.compareCommitsWithBasehead({
          owner: input.owner,
          repo: input.repository,
          basehead: `${base}...${input.headSha}`,
          per_page: 100,
          page,
        });

        const files = response.data.files ?? [];
        const match = files.find((file) => normalizePath(file.filename) === path);

        if (match) {
          return match.patch
            ? selectFixDiff(match.patch, prior.originalLine ?? finding.line)
            : null;
        }

        if (files.length < 100) {
          break;
        }
      }
    } catch (error) {
      console.warn(
        "[InlineReviewComments] fix diff unavailable:",
        error instanceof Error ? error.message : "unknown error",
      );
    }

    return null;
  }

  private async createComment(
    input: InlineSyncInput,
    finding: ReviewFinding,
    target: CommentTarget,
    body: string,
  ): Promise<string | null> {
    let url: string | null = null;

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

      url = created.data.html_url;
    });

    return url;
  }

  private async listThreads(input: InlineSyncInput) {
    const threads = new Map<
      number,
      { id: string; isResolved: boolean; isOutdated: boolean }
    >();
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
            threads.set(first, {
              id: node.id,
              isResolved: node.isResolved,
              isOutdated: node.isOutdated === true,
            });
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

  /** Runs an action; returns true when it succeeded. */
  private async safely(action: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      console.warn(
        `[InlineReviewComments] ${action} failed:`,
        error instanceof Error ? error.message : "unknown error",
      );
      return false;
    }
  }
}
