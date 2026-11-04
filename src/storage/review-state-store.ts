import type { ReviewState, ReviewStateKey } from "./review-state.js";

export interface ReviewStateStore {
  /**
   * Loads the latest persisted state for a repository pull request.
   *
   * Returns null when no previous review state exists.
   */
  load(key: ReviewStateKey): Promise<ReviewState | null>;

  /**
   * Persists the latest state for a repository pull request.
   */
  save(state: ReviewState): Promise<void>;
}

export class ReviewStateStoreError extends Error {
  constructor(
    public readonly code:
      | "LOAD_FAILED"
      | "SAVE_FAILED"
      | "INVALID_STATE"
      | "INTEGRITY_CHECK_FAILED"
      | "CONCURRENT_UPDATE",
    message: string,
  ) {
    super(message);
    this.name = "ReviewStateStoreError";
  }
}
