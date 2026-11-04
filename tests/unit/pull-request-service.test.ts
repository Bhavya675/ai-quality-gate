import { describe, expect, it, vi } from "vitest";
import {
  PullRequestService,
  PullRequestServiceError,
  type PullRequestApi,
} from "../../src/github/pull-request-service.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const NEW_HEAD_SHA = "c".repeat(40);

function createPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    state: "open",
    draft: false,
    merged: false,
    base: { sha: BASE_SHA },
    head: { sha: HEAD_SHA },
    ...overrides,
  };
}

function createFile(filename = "src/example.ts") {
  return {
    filename,
    status: "modified",
    additions: 5,
    deletions: 2,
    changes: 7,
    patch: "@@ -1,2 +1,5 @@",
  };
}

function createGitHubMock(
  pullRequests: unknown[] = [createPullRequest(), createPullRequest()],
  files = [createFile()],
): PullRequestApi {
  return {
    rest: {
      pulls: {
        get: vi.fn().mockImplementation(async () => {
          const next = pullRequests.shift();

          return { data: next ?? createPullRequest() };
        }),
        // listFiles: vi.fn().mockResolvedValue({ data: files }),
        listFiles: vi
          .fn()
          .mockImplementation(
            async (params: { page: number; per_page: number }) => {
              const start = (params.page - 1) * params.per_page;
              const end = start + params.per_page;

              return {
                data: files.slice(start, end),
              };
            },
          ),
      },
    },
  };
}

const input = {
  owner: "Bhavya675",
  repository: "ai-quality-gate",
  pullRequestNumber: 12,
};

describe("PullRequestService", () => {
  it("retrieves PR details and changed files", async () => {
    const github = createGitHubMock();
    const service = new PullRequestService(github);

    const result = await service.getReviewContext(input);

    expect(result).toEqual({
      ...input,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [createFile()],
    });

    expect(github.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(github.rest.pulls.listFiles).toHaveBeenCalledWith({
      owner: input.owner,
      repo: input.repository,
      pull_number: input.pullRequestNumber,
      per_page: 100,
      page: 1,
    });
  });

  it("rejects draft pull requests", async () => {
    const github = createGitHubMock([createPullRequest({ draft: true })]);
    const service = new PullRequestService(github);

    await expect(service.getReviewContext(input)).rejects.toMatchObject({
      code: "DRAFT_PULL_REQUEST",
    });

    expect(github.rest.pulls.listFiles).not.toHaveBeenCalled();
  });

  it("rejects closed pull requests", async () => {
    const github = createGitHubMock([createPullRequest({ state: "closed" })]);
    const service = new PullRequestService(github);

    await expect(service.getReviewContext(input)).rejects.toMatchObject({
      code: "PULL_REQUEST_NOT_OPEN",
    });
  });

  it("rejects a PR merged before retrieval", async () => {
    const github = createGitHubMock([createPullRequest({ merged: true })]);
    const service = new PullRequestService(github);

    await expect(service.getReviewContext(input)).rejects.toMatchObject({
      code: "PULL_REQUEST_NOT_OPEN",
    });
  });

  it("rejects the result when the PR head changes during retrieval", async () => {
    const github = createGitHubMock([
      createPullRequest(),
      createPullRequest({
        head: { sha: NEW_HEAD_SHA },
      }),
    ]);
    const service = new PullRequestService(github);

    await expect(service.getReviewContext(input)).rejects.toMatchObject({
      code: "STALE_PULL_REQUEST",
    });
  });

  it("retrieves changed files across multiple pages", async () => {
    const files = Array.from({ length: 101 }, (_, index) =>
      createFile(`src/file-${index}.ts`),
    );

    const github = createGitHubMock(undefined, files);
    const service = new PullRequestService(github);

    const result = await service.getReviewContext(input);

    expect(result.files).toHaveLength(101);
    expect(github.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid GitHub pull request response", async () => {
    const github = createGitHubMock([{ state: "open" }]);
    const service = new PullRequestService(github);

    await expect(service.getReviewContext(input)).rejects.toMatchObject({
      code: "INVALID_GITHUB_RESPONSE",
    });
  });

  it("does not expose GitHub API error details", async () => {
    const github = createGitHubMock();
    vi.mocked(github.rest.pulls.get).mockRejectedValue(
      new Error("Sensitive internal API detail"),
    );

    const service = new PullRequestService(github);

    await expect(service.getReviewContext(input)).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
      message: "Unable to retrieve pull request information from GitHub.",
    });
  });
});
