import { describe, expect, it, vi } from "vitest";

import {
  PullRequestSourceService,
  PullRequestSourceServiceError,
  type SourceGitHubApi,
} from "../../src/github/pull-request-source-service.js";

const HEAD_SHA = "b".repeat(40);

function createGitHubMock(
  implementation?: (params: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }) => Promise<{ data: unknown }>,
): SourceGitHubApi {
  const defaultImplementation = async () => ({
    data: {
      type: "file",
      encoding: "base64",
      content: Buffer.from("export const value = 42;").toString("base64"),
      size: Buffer.byteLength("export const value = 42;"),
    },
  });

  return {
    rest: {
      repos: {
        getContent: vi.fn(implementation ?? defaultImplementation),
      },
    },
  };
}

function notFoundError() {
  return Object.assign(new Error("Not Found"), {
    status: 404,
  });
}

function forbiddenError() {
  return Object.assign(new Error("Forbidden"), {
    status: 403,
  });
}

describe("PullRequestSourceService.findMissingPaths", () => {
  it("does not mark an existing file as missing", async () => {
    const github = createGitHubMock();
    const service = new PullRequestSourceService(github);

    const result = await service.findMissingPaths(
      "Bhavya675",
      "ai-quality-gate",
      HEAD_SHA,
      ["src/examples/order-service.ts"],
    );

    expect(result).toEqual([]);
  });

  it("identifies a file that returns GitHub 404", async () => {
    const github = createGitHubMock(async () => {
      throw notFoundError();
    });

    const service = new PullRequestSourceService(github);

    const result = await service.findMissingPaths(
      "Bhavya675",
      "ai-quality-gate",
      HEAD_SHA,
      ["src/examples/order-service.ts"],
    );

    expect(result).toEqual(["src/examples/order-service.ts"]);
  });

  it("identifies a path that now refers to a directory", async () => {
    const github = createGitHubMock(async () => ({
      data: [{ name: "example.ts", type: "file" }],
    }));

    const service = new PullRequestSourceService(github);

    const result = await service.findMissingPaths(
      "Bhavya675",
      "ai-quality-gate",
      HEAD_SHA,
      ["src/examples/order-service.ts"],
    );

    expect(result).toEqual(["src/examples/order-service.ts"]);
  });

  it("does not treat a GitHub 403 as a missing file", async () => {
    const github = createGitHubMock(async () => {
      throw forbiddenError();
    });

    const service = new PullRequestSourceService(github);

    await expect(
      service.findMissingPaths("Bhavya675", "ai-quality-gate", HEAD_SHA, [
        "src/examples/order-service.ts",
      ]),
    ).rejects.toMatchObject({
      name: "PullRequestSourceServiceError",
      code: "GITHUB_API_FAILED",
    });
  });

  it("rejects an invalid repository identity", async () => {
    const github = createGitHubMock();
    const service = new PullRequestSourceService(github);

    await expect(
      service.findMissingPaths("", "ai-quality-gate", HEAD_SHA, [
        "src/examples/order-service.ts",
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    expect(github.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it("rejects an invalid commit SHA", async () => {
    const github = createGitHubMock();
    const service = new PullRequestSourceService(github);

    await expect(
      service.findMissingPaths("Bhavya675", "ai-quality-gate", "invalid-sha", [
        "src/examples/order-service.ts",
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("returns an empty list without calling GitHub when no paths are supplied", async () => {
    const github = createGitHubMock();
    const service = new PullRequestSourceService(github);

    const result = await service.findMissingPaths(
      "Bhavya675",
      "ai-quality-gate",
      HEAD_SHA,
      [],
    );

    expect(result).toEqual([]);
    expect(github.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it("removes duplicate paths before checking them", async () => {
    const github = createGitHubMock(async () => {
      throw notFoundError();
    });

    const service = new PullRequestSourceService(github);

    const result = await service.findMissingPaths(
      "Bhavya675",
      "ai-quality-gate",
      HEAD_SHA,
      ["src/examples/order-service.ts", "src/examples/order-service.ts"],
    );

    expect(result).toEqual(["src/examples/order-service.ts"]);

    expect(github.rest.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe file paths", async () => {
    const github = createGitHubMock();
    const service = new PullRequestSourceService(github);

    await expect(
      service.findMissingPaths("Bhavya675", "ai-quality-gate", HEAD_SHA, [
        "../outside-repository.ts",
      ]),
    ).rejects.toBeInstanceOf(PullRequestSourceServiceError);

    expect(github.rest.repos.getContent).not.toHaveBeenCalled();
  });
});
