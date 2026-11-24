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

import { RESULT_MARKER } from "./result-comment-renderer.js";

const START_MARKER = "<!-- AI_QUALITY_GATE_STATE_START -->";
const END_MARKER = "<!-- AI_QUALITY_GATE_STATE_END -->";

const COMMENTS_PER_PAGE = 100;
const MAX_PAGES = 20;
// GitHub rejects comments longer than 65,536 characters.
const MAX_COMMENT_CHARS = 64_000;

const PLACEHOLDER_BODY = `${RESULT_MARKER}\n## ⏳ AI quality gate: review in progress…`;

interface StateComment {
  id: number;
  body: string;
}

/** The hidden state block (markers included), or null when there is none. */
export function extractStateBlock(
  body: string | null | undefined,
): string | null {
  if (!body) {
    return null;
  }

  const start = body.indexOf(START_MARKER);
  const end = body.indexOf(END_MARKER);

  if (
    start === -1 ||
    end === -1 ||
    end <= start ||
    body.indexOf(START_MARKER, start + 1) !== -1 ||
    body.indexOf(END_MARKER, end + 1) !== -1
  ) {
    return null;
  }

  return body.slice(start, end + END_MARKER.length);
}

/** Visible summary text with the hidden state block appended. */
export function withStateBlock(visible: string, block: string | null): string {
  return block ? `${visible.trimEnd()}\n\n${block}` : visible;
}

function stripStateBlock(body: string): string {
  const block = extractStateBlock(body);

  return block ? body.replace(block, "").trimEnd() : body;
}

function buildStateBlock(serialized: string): string {
  const encoded = Buffer.from(serialized, "utf8").toString("base64");

  // Base64 never contains "--" or ">", so it is safe inside an HTML comment.
  return [START_MARKER, `<!-- ${encoded} -->`, END_MARKER].join("\n");
}

function decodeBlock(block: string): string {
  const between = block
    .slice(START_MARKER.length, block.length - END_MARKER.length)
    .trim();

  // Current format: base64 inside an HTML comment. Legacy: bare base64.
  const wrapped = /^<!--([\s\S]*)-->$/.exec(between);
  const encoded = (wrapped ? wrapped[1] : between).trim();

  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new ReviewStateStoreError(
      "INTEGRITY_CHECK_FAILED",
      "AI Quality Gate state encoding is invalid.",
    );
  }
}

function integrityError(message: string): ReviewStateStoreError {
  return new ReviewStateStoreError("INTEGRITY_CHECK_FAILED", message);
}

/**
 * Keeps the review state inside the summary comment, in a hidden HTML
 * comment, so the pull request shows a single AI Quality Gate comment.
 * State found in the older separate state comment is still read and is
 * migrated (and that comment deleted) on the next save.
 */
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
      const found = await this.findComments(
        owner,
        repo,
        validatedKey.pullRequestNumber,
      );

      const source = this.stateSource(found);

      if (!source) {
        return null;
      }

      return decodeReviewState(
        decodeBlock(source.block),
        this.signingSecret,
        validatedKey,
      );
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
      const block = buildStateBlock(
        encodeReviewState(validatedState, this.signingSecret),
      );

      const found = await this.findComments(
        owner,
        repo,
        validatedState.pullRequestNumber,
      );

      // Do not overwrite existing state until its signature
      // and PR identity have been verified.
      const existing = this.stateSource(found);

      if (existing) {
        decodeReviewState(decodeBlock(existing.block), this.signingSecret, {
          repository: validatedState.repository,
          pullRequestNumber: validatedState.pullRequestNumber,
        });
      }

      const unified = found.unified[0];

      if (unified) {
        const body = withStateBlock(stripStateBlock(unified.body), block);
        this.assertFits(body);

        await this.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: unified.id,
          body,
        });
      } else {
        const body = withStateBlock(PLACEHOLDER_BODY, block);
        this.assertFits(body);

        await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: validatedState.pullRequestNumber,
          body,
        });
      }

      // The state now lives in the summary: remove the old separate comment.
      const legacy = found.legacy[0];

      if (legacy) {
        try {
          await this.octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: legacy.id,
          });
        } catch (error) {
          console.warn(
            "[ReviewStateStore] Could not delete the old state comment:",
            error instanceof Error ? error.message : "unknown error",
          );
        }
      }
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

  private assertFits(body: string): void {
    if (body.length > MAX_COMMENT_CHARS) {
      throw new ReviewStateStoreError(
        "SAVE_FAILED",
        "Review state is too large to store in the summary comment.",
      );
    }
  }

  /** The comment whose state block is the current state. */
  private stateSource(found: {
    unified: StateComment[];
    legacy: StateComment[];
  }): { block: string } | null {
    const unified = found.unified[0];

    if (unified) {
      const hasMarkers =
        unified.body.includes(START_MARKER) ||
        unified.body.includes(END_MARKER);
      const block = extractStateBlock(unified.body);

      if (block) {
        return { block };
      }

      if (hasMarkers) {
        throw integrityError("AI Quality Gate state markers are invalid.");
      }
    }

    const legacy = found.legacy[0];

    if (legacy) {
      const block = extractStateBlock(legacy.body);

      if (!block) {
        throw integrityError("AI Quality Gate state markers are invalid.");
      }

      return { block };
    }

    return null;
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

  /**
   * unified: the summary comment (it carries RESULT_MARKER).
   * legacy: an older separate state comment (state markers, no summary).
   */
  private async findComments(
    owner: string,
    repo: string,
    pullRequestNumber: number,
  ): Promise<{ unified: StateComment[]; legacy: StateComment[] }> {
    const unified: StateComment[] = [];
    const legacy: StateComment[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullRequestNumber,
        per_page: COMMENTS_PER_PAGE,
        page,
      });

      for (const comment of response.data) {
        const body = comment.body ?? "";

        if (body.includes(RESULT_MARKER)) {
          unified.push({ id: comment.id, body });
        } else if (body.includes(START_MARKER)) {
          legacy.push({ id: comment.id, body });
        }
      }

      if (response.data.length < COMMENTS_PER_PAGE) {
        break;
      }
    }

    if (unified.length > 1 || legacy.length > 1) {
      throw new ReviewStateStoreError(
        "CONCURRENT_UPDATE",
        "Multiple AI Quality Gate state comments were found.",
      );
    }

    return { unified, legacy };
  }
}
