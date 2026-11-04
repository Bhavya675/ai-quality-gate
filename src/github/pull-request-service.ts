import { z } from "zod";
import {
  assertHeadShaCurrent,
  PullRequestReviewGuardError,
} from "./pull-request-review-guard.js";

const PullRequestInputSchema = z
  .object({
    owner: z.string().trim().min(1),
    repository: z.string().trim().min(1),
    pullRequestNumber: z.number().int().positive(),
  })
  .strict();

const PullRequestApiResponseSchema = z.object({
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  base: z.object({
    sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
  }),
  head: z.object({
    sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
  }),
});

const ChangedFileSchema = z.object({
  filename: z.string().min(1),
  status: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().optional(),
});

export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export interface PullRequestContext {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
}

export interface PullRequestApi {
  rest: {
    pulls: {
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{ data: unknown }>;

      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: unknown }>;
    };
  };
}

export class PullRequestServiceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "PULL_REQUEST_NOT_OPEN"
      | "DRAFT_PULL_REQUEST"
      | "INVALID_GITHUB_RESPONSE"
      | "TOO_MANY_CHANGED_FILES"
      | "GITHUB_API_FAILED"
      | "STALE_PULL_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "PullRequestServiceError";
  }
}

const PAGE_SIZE = 100;
const MAX_CHANGED_FILES = 3000;

export class PullRequestService {
  constructor(private readonly github: PullRequestApi) {}

  async getReviewContext(input: {
    owner: string;
    repository: string;
    pullRequestNumber: number;
  }): Promise<PullRequestContext> {
    const inputValidation = PullRequestInputSchema.safeParse(input);

    if (!inputValidation.success) {
      throw new PullRequestServiceError(
        "INVALID_INPUT",
        "Invalid pull request identity.",
      );
    }

    const identity = inputValidation.data;

    try {
      const initialPullRequest = await this.getPullRequest(identity);

      if (initialPullRequest.state !== "open" || initialPullRequest.merged) {
        throw new PullRequestServiceError(
          "PULL_REQUEST_NOT_OPEN",
          "The pull request is not open.",
        );
      }

      if (initialPullRequest.draft) {
        throw new PullRequestServiceError(
          "DRAFT_PULL_REQUEST",
          "Draft pull requests are not eligible for review.",
        );
      }

      const files = await this.getChangedFiles(identity);

      const latestPullRequest = await this.getPullRequest(identity);

      try {
        assertHeadShaCurrent(
          initialPullRequest.head.sha,
          latestPullRequest.head.sha,
        );
      } catch (error) {
        if (
          error instanceof PullRequestReviewGuardError &&
          error.code === "STALE_REVIEW"
        ) {
          throw new PullRequestServiceError(
            "STALE_PULL_REQUEST",
            "The pull request changed while its files were being retrieved. Retry using the latest commit.",
          );
        }

        throw error;
      }

      if (latestPullRequest.state !== "open" || latestPullRequest.merged) {
        throw new PullRequestServiceError(
          "PULL_REQUEST_NOT_OPEN",
          "The pull request was closed while its files were being retrieved.",
        );
      }

      if (latestPullRequest.draft) {
        throw new PullRequestServiceError(
          "DRAFT_PULL_REQUEST",
          "The pull request was converted to draft while its files were being retrieved.",
        );
      }

      return {
        ...identity,
        baseSha: latestPullRequest.base.sha,
        headSha: latestPullRequest.head.sha,
        files,
      };
    } catch (error) {
      if (error instanceof PullRequestServiceError) {
        throw error;
      }

      const details =
        error instanceof Error ? error.message : "Unknown GitHub API error";

      throw new PullRequestServiceError(
        "GITHUB_API_FAILED",
        `Unable to retrieve pull request information from GitHub: ${details}`,
      );
    }
  }

  /**
   * Retrieves the current PR head SHA immediately before review state
   * persistence and rejects PRs that are no longer eligible for review.
   */
  async getLatestHeadSha(input: {
    owner: string;
    repository: string;
    pullRequestNumber: number;
  }): Promise<string> {
    const inputValidation = PullRequestInputSchema.safeParse(input);

    if (!inputValidation.success) {
      throw new PullRequestServiceError(
        "INVALID_INPUT",
        "Invalid pull request identity.",
      );
    }

    try {
      const pullRequest = await this.getPullRequest(inputValidation.data);

      if (pullRequest.state !== "open" || pullRequest.merged) {
        throw new PullRequestServiceError(
          "PULL_REQUEST_NOT_OPEN",
          "The pull request is no longer open or has already been merged.",
        );
      }

      if (pullRequest.draft) {
        throw new PullRequestServiceError(
          "DRAFT_PULL_REQUEST",
          "The pull request is now a draft and is not eligible for review.",
        );
      }

      return pullRequest.head.sha;
    } catch (error) {
      if (error instanceof PullRequestServiceError) {
        throw error;
      }

      throw new PullRequestServiceError(
        "GITHUB_API_FAILED",
        "Unable to verify the latest pull request status.",
      );
    }
  }

  private async getPullRequest(identity: {
    owner: string;
    repository: string;
    pullRequestNumber: number;
  }) {
    const response = await this.github.rest.pulls.get({
      owner: identity.owner,
      repo: identity.repository,
      pull_number: identity.pullRequestNumber,
    });

    const validation = PullRequestApiResponseSchema.safeParse(response.data);

    if (!validation.success) {
      throw new PullRequestServiceError(
        "INVALID_GITHUB_RESPONSE",
        "GitHub returned an invalid pull request response.",
      );
    }

    return validation.data;
  }

  private async getChangedFiles(identity: {
    owner: string;
    repository: string;
    pullRequestNumber: number;
  }): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];

    for (let page = 1; page <= MAX_CHANGED_FILES / PAGE_SIZE; page++) {
      const response = await this.github.rest.pulls.listFiles({
        owner: identity.owner,
        repo: identity.repository,
        pull_number: identity.pullRequestNumber,
        per_page: PAGE_SIZE,
        page,
      });

      if (!Array.isArray(response.data)) {
        throw new PullRequestServiceError(
          "INVALID_GITHUB_RESPONSE",
          "GitHub returned an invalid changed-files response.",
        );
      }

      const validation = z.array(ChangedFileSchema).safeParse(response.data);

      if (!validation.success) {
        throw new PullRequestServiceError(
          "INVALID_GITHUB_RESPONSE",
          "GitHub returned invalid changed-file information.",
        );
      }

      files.push(...validation.data);

      if (files.length > MAX_CHANGED_FILES) {
        throw new PullRequestServiceError(
          "TOO_MANY_CHANGED_FILES",
          "The pull request exceeds the supported changed-file limit.",
        );
      }

      if (validation.data.length < PAGE_SIZE) {
        return files;
      }
    }

    return files;
  }
}
