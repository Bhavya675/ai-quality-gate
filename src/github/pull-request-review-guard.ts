import { z } from "zod";

const PullRequestIdentitySchema = z
  .object({
    owner: z.string().trim().min(1),
    repository: z.string().trim().min(1),
    pullRequestNumber: z.number().int().positive(),
  })
  .strict();

const CommitShaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);

export class PullRequestReviewGuardError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PULL_REQUEST_IDENTITY"
      | "INVALID_COMMIT_SHA"
      | "STALE_REVIEW",
    message: string,
  ) {
    super(message);
    this.name = "PullRequestReviewGuardError";
  }
}

export function createPullRequestLockKey(
  owner: string,
  repository: string,
  pullRequestNumber: number,
): string {
  const validation = PullRequestIdentitySchema.safeParse({
    owner,
    repository,
    pullRequestNumber,
  });

  if (!validation.success) {
    throw new PullRequestReviewGuardError(
      "INVALID_PULL_REQUEST_IDENTITY",
      "Invalid pull request identity.",
    );
  }

  const identity = validation.data;

  return `${identity.owner.toLowerCase()}/${identity.repository.toLowerCase()}#${identity.pullRequestNumber}`;
}

export class PullRequestReviewGuard {
  private readonly locks = new Map<string, Promise<void>>();

  async runExclusive<T>(
    owner: string,
    repository: string,
    pullRequestNumber: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = createPullRequestLockKey(owner, repository, pullRequestNumber);

    const previous = this.locks.get(key) ?? Promise.resolve();

    let release!: () => void;

    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = previous.then(() => current);

    this.locks.set(key, tail);

    await previous;

    try {
      return await operation();
    } finally {
      release();

      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    }
  }
}

export function assertHeadShaCurrent(
  reviewedHeadSha: string,
  latestHeadSha: string,
): void {
  const reviewedValidation = CommitShaSchema.safeParse(reviewedHeadSha);
  const latestValidation = CommitShaSchema.safeParse(latestHeadSha);

  if (!reviewedValidation.success || !latestValidation.success) {
    throw new PullRequestReviewGuardError(
      "INVALID_COMMIT_SHA",
      "A valid 40-character commit SHA is required.",
    );
  }

  if (
    reviewedValidation.data.toLowerCase() !==
    latestValidation.data.toLowerCase()
  ) {
    throw new PullRequestReviewGuardError(
      "STALE_REVIEW",
      "The pull request changed while the review was running. Discard this review and review the latest commit.",
    );
  }
}
