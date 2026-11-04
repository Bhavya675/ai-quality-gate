import { describe, expect, it } from "vitest";

import {
  createGitHubClient,
  GitHubClientError,
} from "../../src/github/github-client.js";

describe("GitHub client", () => {
  it("creates an authenticated Octokit client", () => {
    const client = createGitHubClient("test-github-token");

    expect(client).toBeDefined();
    expect(client.rest).toBeDefined();
    expect(client.rest.issues).toBeDefined();
    expect(client.rest.pulls).toBeDefined();
    expect(client.rest.repos).toBeDefined();
  });

  it("rejects an empty token", () => {
    expect(() => createGitHubClient("")).toThrowError(GitHubClientError);
  });

  it("rejects a whitespace-only token", () => {
    expect(() => createGitHubClient("   ")).toThrowError(GitHubClientError);
  });

  it("does not expose the supplied token in error messages", () => {
    const secret = "test-github-token";

    try {
      createGitHubClient("");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
