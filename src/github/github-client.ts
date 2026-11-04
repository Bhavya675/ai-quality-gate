import { Octokit } from "@octokit/rest";

export class GitHubClientError extends Error {
  constructor(
    public readonly code: "MISSING_TOKEN" | "CLIENT_INITIALIZATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitHubClientError";
  }
}

/**
 * Creates an authenticated GitHub API client.
 *
 * The token should be supplied by the execution environment,
 * such as GitHub Actions' automatically generated GITHUB_TOKEN.
 */
export function createGitHubClient(token: string): Octokit {
  if (typeof token !== "string" || !token.trim()) {
    throw new GitHubClientError(
      "MISSING_TOKEN",
      "GitHub authentication token is required.",
    );
  }

  try {
    return new Octokit({
      auth: token,
      userAgent: "ai-quality-gate",
      timeZone: "UTC",
    });
  } catch {
    throw new GitHubClientError(
      "CLIENT_INITIALIZATION_FAILED",
      "Unable to initialize the GitHub API client.",
    );
  }
}
