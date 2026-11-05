import { z } from "zod";
import type { ChangedFile } from "./pull-request-service.js";

const SourceFileResponseSchema = z.object({
  type: z.string(),
  encoding: z.string().optional(),
  content: z.string().optional(),
  size: z.number().int().nonnegative(),
});

const ExistingPathResponseSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const CommitShaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);

export interface SourceFile {
  path: string;
  status: string;
  content: string;
  sizeBytes: number;
}

export interface SourceRetrievalResult {
  files: SourceFile[];
  skippedFiles: Array<{
    path: string;
    reason: "DELETED";
  }>;
  totalBytes: number;
}

export interface SourceGitHubApi {
  rest: {
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }): Promise<{ data: unknown }>;
    };
  };
}

export interface SourceRetrievalOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  concurrency?: number;
}

export class PullRequestSourceServiceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "INVALID_GITHUB_RESPONSE"
      | "UNSUPPORTED_FILE_TYPE"
      | "FILE_TOO_LARGE"
      | "TOTAL_SIZE_EXCEEDED"
      | "BINARY_FILE"
      | "INVALID_TEXT_ENCODING"
      | "GITHUB_API_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PullRequestSourceServiceError";
  }
}

const DEFAULT_MAX_FILE_BYTES = 500_000;
const DEFAULT_MAX_TOTAL_BYTES = 5_000_000;
const DEFAULT_CONCURRENCY = 5;

function validatePath(path: string): void {
  if (
    !path.trim() ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new PullRequestSourceServiceError(
      "INVALID_INPUT",
      "Invalid source-file path.",
    );
  }
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;

    return typeof status === "number" ? status : undefined;
  }

  return undefined;
}

function decodeText(content: string): Buffer {
  const buffer = Buffer.from(content, "base64");

  if (buffer.includes(0)) {
    throw new PullRequestSourceServiceError(
      "BINARY_FILE",
      "Binary files cannot be sent to the AI reviewer as source text.",
    );
  }

  const decoded = buffer.toString("utf8");

  if (!Buffer.from(decoded, "utf8").equals(buffer)) {
    throw new PullRequestSourceServiceError(
      "INVALID_TEXT_ENCODING",
      "The source file is not valid UTF-8 text.",
    );
  }

  return buffer;
}

export class PullRequestSourceService {
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly concurrency: number;

  constructor(
    private readonly github: SourceGitHubApi,
    options: SourceRetrievalOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

    if (
      !Number.isInteger(this.maxFileBytes) ||
      this.maxFileBytes <= 0 ||
      !Number.isInteger(this.maxTotalBytes) ||
      this.maxTotalBytes <= 0 ||
      !Number.isInteger(this.concurrency) ||
      this.concurrency <= 0
    ) {
      throw new Error("Invalid source retrieval configuration.");
    }
  }

  /**
   * Checks whether previous finding paths still exist as regular files
   * at the supplied commit.
   *
   * A GitHub 404 or a directory/non-file response means that the
   * previous source-file path no longer exists as a regular file.
   *
   * Other API failures are not treated as missing files.
   */
  async findMissingPaths(
    owner: string,
    repository: string,
    headSha: string,
    filePaths: string[],
  ): Promise<string[]> {
    if (
      !owner.trim() ||
      !repository.trim() ||
      !CommitShaSchema.safeParse(headSha).success
    ) {
      throw new PullRequestSourceServiceError(
        "INVALID_INPUT",
        "Invalid repository identity or head commit SHA.",
      );
    }

    const uniquePaths = [...new Set(filePaths)];

    for (const path of uniquePaths) {
      validatePath(path);
    }

    if (uniquePaths.length === 0) {
      return [];
    }

    const missingPaths = new Set<string>();
    let nextIndex = 0;

    const workers = Array.from(
      { length: Math.min(this.concurrency, uniquePaths.length) },
      async () => {
        while (true) {
          const index = nextIndex++;

          if (index >= uniquePaths.length) {
            return;
          }

          const path = uniquePaths[index];

          let response: { data: unknown };

          try {
            response = await this.github.rest.repos.getContent({
              owner,
              repo: repository,
              path,
              ref: headSha,
            });
          } catch (error) {
            if (getHttpStatus(error) === 404) {
              missingPaths.add(path);
              continue;
            }

            throw new PullRequestSourceServiceError(
              "GITHUB_API_FAILED",
              "Unable to verify a previous finding path at the current pull request commit.",
            );
          }

          // GitHub returns an array for directory contents.
          // A previous finding path must still be a regular file.
          if (Array.isArray(response.data)) {
            missingPaths.add(path);
            continue;
          }

          const validation = ExistingPathResponseSchema.safeParse(
            response.data,
          );

          if (!validation.success) {
            throw new PullRequestSourceServiceError(
              "INVALID_GITHUB_RESPONSE",
              "GitHub returned an invalid path-existence response.",
            );
          }

          if (validation.data.type !== "file") {
            missingPaths.add(path);
          }
        }
      },
    );

    await Promise.all(workers);

    // Preserve the original input order.
    return uniquePaths.filter((path) => missingPaths.has(path));
  }

  async retrieve(
    owner: string,
    repository: string,
    headSha: string,
    changedFiles: ChangedFile[],
  ): Promise<SourceRetrievalResult> {
    if (
      !owner.trim() ||
      !repository.trim() ||
      !CommitShaSchema.safeParse(headSha).success
    ) {
      throw new PullRequestSourceServiceError(
        "INVALID_INPUT",
        "Invalid repository identity or head commit SHA.",
      );
    }

    const paths = new Set<string>();

    for (const file of changedFiles) {
      validatePath(file.filename);

      if (paths.has(file.filename)) {
        throw new PullRequestSourceServiceError(
          "INVALID_INPUT",
          "Duplicate changed-file paths were provided.",
        );
      }

      paths.add(file.filename);
    }

    const eligibleFiles = changedFiles.filter(
      (file) => file.status !== "removed",
    );

    const skippedFiles = changedFiles
      .filter((file) => file.status === "removed")
      .map((file) => ({
        path: file.filename,
        reason: "DELETED" as const,
      }));

    const results: SourceFile[] = [];
    let nextIndex = 0;
    let totalBytes = 0;

    const workers = Array.from(
      { length: Math.min(this.concurrency, eligibleFiles.length) },
      async () => {
        while (true) {
          const index = nextIndex++;

          if (index >= eligibleFiles.length) {
            return;
          }

          const changedFile = eligibleFiles[index];

          const sourceFile = await this.retrieveFile(
            owner,
            repository,
            headSha,
            changedFile,
          );

          totalBytes += sourceFile.sizeBytes;

          if (totalBytes > this.maxTotalBytes) {
            throw new PullRequestSourceServiceError(
              "TOTAL_SIZE_EXCEEDED",
              "The pull request source exceeds the configured total size limit.",
            );
          }

          results[index] = sourceFile;
        }
      },
    );

    await Promise.all(workers);

    return {
      files: results,
      skippedFiles,
      totalBytes,
    };
  }

  private async retrieveFile(
    owner: string,
    repository: string,
    headSha: string,
    changedFile: ChangedFile,
  ): Promise<SourceFile> {
    let response: { data: unknown };

    try {
      response = await this.github.rest.repos.getContent({
        owner,
        repo: repository,
        path: changedFile.filename,
        ref: headSha,
      });
    } catch {
      throw new PullRequestSourceServiceError(
        "GITHUB_API_FAILED",
        "Unable to retrieve a changed file from GitHub.",
      );
    }

    const validation = SourceFileResponseSchema.safeParse(response.data);

    if (!validation.success) {
      throw new PullRequestSourceServiceError(
        "INVALID_GITHUB_RESPONSE",
        "GitHub returned an invalid source-file response.",
      );
    }

    const data = validation.data;

    if (data.type !== "file") {
      throw new PullRequestSourceServiceError(
        "UNSUPPORTED_FILE_TYPE",
        "The changed path is not a regular file.",
      );
    }

    if (data.size > this.maxFileBytes) {
      throw new PullRequestSourceServiceError(
        "FILE_TOO_LARGE",
        "A changed file exceeds the configured file size limit.",
      );
    }

    if (data.encoding !== "base64" || !data.content) {
      throw new PullRequestSourceServiceError(
        "INVALID_GITHUB_RESPONSE",
        "GitHub did not return file contents in the expected format.",
      );
    }

    const buffer = decodeText(data.content);

    if (buffer.length !== data.size) {
      throw new PullRequestSourceServiceError(
        "INVALID_GITHUB_RESPONSE",
        "The retrieved source size does not match GitHub metadata.",
      );
    }

    return {
      path: changedFile.filename,
      status: changedFile.status,
      content: buffer.toString("utf8"),
      sizeBytes: buffer.length,
    };
  }
}
