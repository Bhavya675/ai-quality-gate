import { describe, expect, it, vi } from "vitest";
import {
  PullRequestSourceService,
  PullRequestSourceServiceError,
  type SourceGitHubApi,
} from "../../src/github/pull-request-source-service.js";
import type { ChangedFile } from "../../src/github/pull-request-service.js";

const HEAD_SHA = "b".repeat(40);

function createChangedFile(filename: string, status = "modified"): ChangedFile {
  return {
    filename,
    status,
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1 +1 @@",
  };
}

function createApi(contents: Record<string, string>): SourceGitHubApi {
  return {
    rest: {
      repos: {
        getContent: vi
          .fn()
          .mockImplementation(async (params: { path: string }) => {
            const content = contents[params.path];

            if (content === undefined) {
              throw new Error("File not found");
            }

            return {
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(content).toString("base64"),
                size: Buffer.byteLength(content),
              },
            };
          }),
      },
    },
  };
}

describe("PullRequestSourceService", () => {
  it("retrieves source at the exact PR head SHA", async () => {
    const api = createApi({
      "src/example.ts": "export const value = 42;",
    });

    const service = new PullRequestSourceService(api);

    const result = await service.retrieve("owner", "repository", HEAD_SHA, [
      createChangedFile("src/example.ts"),
    ]);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toBe("export const value = 42;");

    expect(api.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repository",
      path: "src/example.ts",
      ref: HEAD_SHA,
    });
  });

  it("skips deleted files", async () => {
    const api = createApi({});
    const service = new PullRequestSourceService(api);

    const result = await service.retrieve("owner", "repository", HEAD_SHA, [
      createChangedFile("src/deleted.ts", "removed"),
    ]);

    expect(result.files).toHaveLength(0);
    expect(result.skippedFiles).toEqual([
      { path: "src/deleted.ts", reason: "DELETED" },
    ]);
    expect(api.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it("retrieves renamed files using their new path", async () => {
    const api = createApi({
      "src/new-name.ts": "export const renamed = true;",
    });

    const service = new PullRequestSourceService(api);

    const result = await service.retrieve("owner", "repository", HEAD_SHA, [
      createChangedFile("src/new-name.ts", "renamed"),
    ]);

    expect(result.files[0].path).toBe("src/new-name.ts");
  });

  it("rejects files exceeding the per-file limit", async () => {
    const api = createApi({
      "large.ts": "1234567890",
    });

    const service = new PullRequestSourceService(api, {
      maxFileBytes: 5,
    });

    await expect(
      service.retrieve("owner", "repository", HEAD_SHA, [
        createChangedFile("large.ts"),
      ]),
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("rejects source exceeding the total size limit", async () => {
    const api = createApi({
      "one.ts": "123456",
      "two.ts": "789012",
    });

    const service = new PullRequestSourceService(api, {
      maxTotalBytes: 10,
    });

    await expect(
      service.retrieve("owner", "repository", HEAD_SHA, [
        createChangedFile("one.ts"),
        createChangedFile("two.ts"),
      ]),
    ).rejects.toMatchObject({
      code: "TOTAL_SIZE_EXCEEDED",
    });
  });

  it("rejects binary files", async () => {
    const api = createApi({
      "image.png": "a\u0000b",
    });

    const service = new PullRequestSourceService(api);

    await expect(
      service.retrieve("owner", "repository", HEAD_SHA, [
        createChangedFile("image.png"),
      ]),
    ).rejects.toMatchObject({
      code: "BINARY_FILE",
    });
  });

  it("rejects invalid file paths", async () => {
    const api = createApi({});
    const service = new PullRequestSourceService(api);

    await expect(
      service.retrieve("owner", "repository", HEAD_SHA, [
        createChangedFile("../secrets.txt"),
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects invalid commit SHAs", async () => {
    const api = createApi({});
    const service = new PullRequestSourceService(api);

    await expect(
      service.retrieve("owner", "repository", "invalid-sha", []),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects unsupported GitHub content types", async () => {
    const api: SourceGitHubApi = {
      rest: {
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: {
              type: "symlink",
              size: 10,
            },
          }),
        },
      },
    };

    const service = new PullRequestSourceService(api);

    await expect(
      service.retrieve("owner", "repository", HEAD_SHA, [
        createChangedFile("link"),
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
  });

  it("rejects GitHub API failures without exposing details", async () => {
    const api: SourceGitHubApi = {
      rest: {
        repos: {
          getContent: vi
            .fn()
            .mockRejectedValue(new Error("Internal GitHub API detail")),
        },
      },
    };

    const service = new PullRequestSourceService(api);

    await expect(
      service.retrieve("owner", "repository", HEAD_SHA, [
        createChangedFile("src/example.ts"),
      ]),
    ).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
      message: "Unable to retrieve a changed file from GitHub.",
    });
  });

  it("rejects duplicate file paths", async () => {
    const api = createApi({});
    const service = new PullRequestSourceService(api);

    await expect(
      service.retrieve("owner", "repository", HEAD_SHA, [
        createChangedFile("src/example.ts"),
        createChangedFile("src/example.ts"),
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
