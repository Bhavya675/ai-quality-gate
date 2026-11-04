import type { Octokit } from "@octokit/rest";

import {
  decodeReviewState,
  encodeReviewState,
} from "../storage/review-state-codec.js";

import {
  ReviewStateKeySchema,
  ReviewStateSchema,
  type ReviewState,
  type ReviewStateKey,
} from "../storage/review-state.js";

import {
  ReviewStateStoreError,
  type ReviewStateStore,
} from "../storage/review-state-store.js";

const START_MARKER = "<!-- AI_QUALITY_GATE_STATE_START -->";
const END_MARKER = "<!-- AI_QUALITY_GATE_STATE_END -->";

const COMMENT_MARKER = `${START_MARKER}\n`;

const COMMENTS_PER_PAGE = 100;

interface StateComment {
  id: number;
  body: string | null;
}

export class GitHubReviewStateCommentStore implements ReviewStateStore {
  constructor(
    private readonly octokit: Octokit,
    private readonly signingSecret: string,
  ) {
    if (Buffer.byteLength(signingSecret, "utf8") < 32) {
      throw new ReviewStateStoreError(
        "INVALID_STATE",
        "Review-state signing secret must contain at least 32 bytes.",
      );
    }
  }

  async load(key: ReviewStateKey): Promise<ReviewState | null> {
    const validatedKey = this.validateKey(key);
    const { owner, repo } = this.parseRepository(validatedKey.repository);

    try {
      const comments = await this.findStateComments(
        owner,
        repo,
        validatedKey.pullRequestNumber,
      );

      if (comments.length === 0) {
        return null;
      }

      if (comments.length > 1) {
        throw new ReviewStateStoreError(
          "CONCURRENT_UPDATE",
          "Multiple AI Quality Gate state comments were found.",
        );
      }

      const serialized = this.extractState(comments[0].body);

      return decodeReviewState(serialized, this.signingSecret, validatedKey);
    } catch (error) {
      if (error instanceof ReviewStateStoreError) {
        throw error;
      }

      throw new ReviewStateStoreError(
        "LOAD_FAILED",
        "Unable to load review state from GitHub.",
      );
    }
  }

  async save(state: ReviewState): Promise<void> {
    const validation = ReviewStateSchema.safeParse(state);

    if (!validation.success) {
      throw new ReviewStateStoreError(
        "INVALID_STATE",
        "Cannot save an invalid review state.",
      );
    }

    const validatedState = validation.data;

    const { owner, repo } = this.parseRepository(validatedState.repository);

    try {
      const serialized = encodeReviewState(validatedState, this.signingSecret);

      const body = this.createCommentBody(serialized);

      const comments = await this.findStateComments(
        owner,
        repo,
        validatedState.pullRequestNumber,
      );

      if (comments.length > 1) {
        throw new ReviewStateStoreError(
          "CONCURRENT_UPDATE",
          "Multiple AI Quality Gate state comments were found.",
        );
      }

      if (comments.length === 1) {
        // Do not overwrite existing state until its signature
        // and PR identity have been verified.
        const existingSerialized = this.extractState(comments[0].body);

        decodeReviewState(existingSerialized, this.signingSecret, {
          repository: validatedState.repository,
          pullRequestNumber: validatedState.pullRequestNumber,
        });

        await this.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: comments[0].id,
          body,
        });

        return;
      }

      await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: validatedState.pullRequestNumber,
        body,
      });
    } catch (error) {
      if (error instanceof ReviewStateStoreError) {
        throw error;
      }

      throw new ReviewStateStoreError(
        "SAVE_FAILED",
        "Unable to save review state to GitHub.",
      );
    }
  }

  private validateKey(key: ReviewStateKey): ReviewStateKey {
    const validation = ReviewStateKeySchema.safeParse(key);

    if (!validation.success) {
      throw new ReviewStateStoreError(
        "INVALID_STATE",
        "Invalid review-state identity.",
      );
    }

    this.parseRepository(validation.data.repository);

    return validation.data;
  }

  private parseRepository(repository: string): { owner: string; repo: string } {
    const parts = repository.split("/");

    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      throw new ReviewStateStoreError(
        "INVALID_STATE",
        "Repository must use the owner/repository format.",
      );
    }

    return {
      owner: parts[0],
      repo: parts[1],
    };
  }

  private async findStateComments(
    owner: string,
    repo: string,
    pullRequestNumber: number,
  ): Promise<StateComment[]> {
    const matches: StateComment[] = [];

    let page = 1;

    while (true) {
      const response = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullRequestNumber,
        per_page: COMMENTS_PER_PAGE,
        page,
      });

      for (const comment of response.data) {
        if (comment.body?.includes(START_MARKER)) {
          matches.push({
            id: comment.id,
            body: comment.body,
          });
        }
      }

      if (response.data.length < COMMENTS_PER_PAGE) {
        break;
      }

      page++;
    }

    return matches;
  }

  private extractState(body: string | null): string {
    if (!body) {
      throw new ReviewStateStoreError(
        "INTEGRITY_CHECK_FAILED",
        "AI Quality Gate state comment has no content.",
      );
    }

    const startIndex = body.indexOf(START_MARKER);
    const endIndex = body.indexOf(END_MARKER);

    if (
      startIndex === -1 ||
      endIndex === -1 ||
      endIndex <= startIndex ||
      body.indexOf(START_MARKER, startIndex + 1) !== -1 ||
      body.indexOf(END_MARKER, endIndex + 1) !== -1
    ) {
      throw new ReviewStateStoreError(
        "INTEGRITY_CHECK_FAILED",
        "AI Quality Gate state markers are invalid.",
      );
    }

    const serialized = body
      .slice(startIndex + START_MARKER.length, endIndex)
      .trim();

    try {
      return Buffer.from(serialized, "base64").toString("utf8");
    } catch {
      throw new ReviewStateStoreError(
        "INTEGRITY_CHECK_FAILED",
        "AI Quality Gate state encoding is invalid.",
      );
    }
  }

  private createCommentBody(serialized: string): string {
    const encoded = Buffer.from(serialized, "utf8").toString("base64");

    return [
      "<!-- AI Quality Gate managed state. Do not edit manually. -->",
      COMMENT_MARKER.trimEnd(),
      encoded,
      END_MARKER,
    ].join("\n");
  }
}
