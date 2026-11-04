import { z } from "zod";

const GitHubPullRequestEventSchema = z
  .object({
    action: z.string().min(1),
    repository: z
      .object({
        name: z.string().min(1),
        owner: z
          .object({
            login: z.string().min(1),
          })
          .strict(),
      })
      .passthrough(),
    pull_request: z
      .object({
        number: z.number().int().positive(),
        draft: z.boolean(),
        state: z.enum(["open", "closed"]),
        merged: z.boolean(),
        base: z
          .object({
            sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
          })
          .passthrough(),
        head: z
          .object({
            sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const SUPPORTED_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

export interface PullRequestEvent {
  action: "opened" | "synchronize" | "reopened" | "ready_for_review";
  repository: string;
  owner: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
}

export type PullRequestEventResult =
  | {
      accepted: true;
      event: PullRequestEvent;
    }
  | {
      accepted: false;
      reason:
        | "UNSUPPORTED_ACTION"
        | "DRAFT_PULL_REQUEST"
        | "PULL_REQUEST_NOT_OPEN";
    };

export class PullRequestEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestEventError";
  }
}

export function parsePullRequestEvent(
  payload: unknown,
): PullRequestEventResult {
  const validation = GitHubPullRequestEventSchema.safeParse(payload);

  if (!validation.success) {
    throw new PullRequestEventError(
      "Invalid GitHub pull request event payload.",
    );
  }

  const data = validation.data;

  if (!SUPPORTED_ACTIONS.has(data.action)) {
    return {
      accepted: false,
      reason: "UNSUPPORTED_ACTION",
    };
  }

  if (data.pull_request.draft) {
    return {
      accepted: false,
      reason: "DRAFT_PULL_REQUEST",
    };
  }

  if (data.pull_request.state !== "open" || data.pull_request.merged) {
    return {
      accepted: false,
      reason: "PULL_REQUEST_NOT_OPEN",
    };
  }

  return {
    accepted: true,
    event: {
      action: data.action as PullRequestEvent["action"],
      repository: data.repository.name,
      owner: data.repository.owner.login,
      pullRequestNumber: data.pull_request.number,
      baseSha: data.pull_request.base.sha,
      headSha: data.pull_request.head.sha,
    },
  };
}
