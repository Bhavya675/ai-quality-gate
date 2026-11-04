import { z } from "zod";

const SensitiveCategorySchema = z.enum([
  "auth-identity",
  "money-movement",
  "ledger-reconciliation",
  "card-lifecycle",
  "customer-personal-data",
  "permissions-limits",
  "external-scheme-integration",
]);

export type SensitiveCategory = z.infer<typeof SensitiveCategorySchema>;

const PolicyConfigSchema = z
  .object({
    excludedDirectoryNames: z
      .array(z.string().min(1))
      .default([
        "node_modules",
        "vendor",
        "dist",
        "build",
        "coverage",
        ".git",
        ".next",
        ".angular",
      ]),
    excludedFileNames: z
      .array(z.string().min(1))
      .default([
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "bun.lock",
      ]),
    excludedExtensions: z
      .array(z.string().min(1))
      .default([
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".ico",
        ".pdf",
        ".zip",
        ".gz",
        ".woff",
        ".woff2",
        ".ttf",
        ".eot",
        ".mp4",
        ".mp3",
        ".exe",
        ".dll",
        ".so",
        ".dylib",
      ]),
    sensitivePathRules: z
      .array(
        z
          .object({
            category: SensitiveCategorySchema,
            patterns: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .default([
        {
          category: "auth-identity",
          patterns: [
            "auth",
            "authentication",
            "authorization",
            "identity",
            "oauth",
            "openid",
            "jwt",
            "token",
            "credential",
            "password",
            "session",
          ],
        },
        {
          category: "money-movement",
          patterns: [
            "payment",
            "payout",
            "transfer",
            "transaction",
            "withdrawal",
            "deposit",
            "refund",
          ],
        },
        {
          category: "ledger-reconciliation",
          patterns: [
            "ledger",
            "reconciliation",
            "accounting",
            "balance",
            "settlement",
          ],
        },
        {
          category: "card-lifecycle",
          patterns: ["card", "activation", "deactivation", "pin", "cardholder"],
        },
        {
          category: "customer-personal-data",
          patterns: [
            "customer",
            "personal-data",
            "personaldata",
            "pii",
            "privacy",
            "profile",
            "address",
          ],
        },
        {
          category: "permissions-limits",
          patterns: [
            "permission",
            "authorization-policy",
            "access-control",
            "role",
            "limit",
            "quota",
          ],
        },
        {
          category: "external-scheme-integration",
          patterns: [
            "scheme",
            "network-integration",
            "external-integration",
            "webhook",
            "third-party",
          ],
        },
      ]),
  })
  .strict();

export type ReviewPolicyConfig = z.input<typeof PolicyConfigSchema>;

export interface PolicyInputFile {
  filename: string;
  status: string;
}

export interface ExcludedFile {
  filename: string;
  reason:
    | "GENERATED_OR_DEPENDENCY_DIRECTORY"
    | "LOCK_FILE"
    | "BINARY_OR_NON_SOURCE_EXTENSION";
}

export interface ReviewPolicyResult {
  eligibleFiles: PolicyInputFile[];
  excludedFiles: ExcludedFile[];
  sensitiveCategories: SensitiveCategory[];
}

export class ReviewPolicyError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIGURATION" | "INVALID_FILE_PATH",
    message: string,
  ) {
    super(message);
    this.name = "ReviewPolicyError";
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function validatePath(path: string): void {
  const normalizedPath = path.replace(/\\/g, "/");

  if (
    !normalizedPath.trim() ||
    normalizedPath.startsWith("/") ||
    /^[a-z]:/i.test(normalizedPath) ||
    normalizedPath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ReviewPolicyError(
      "INVALID_FILE_PATH",
      "Invalid changed-file path.",
    );
  }
}

function containsDirectory(path: string, directoryNames: string[]): boolean {
  const segments = path.split("/");

  return segments.some((segment) =>
    directoryNames.some((directory) => segment === directory.toLowerCase()),
  );
}

function matchesSensitivePattern(path: string, pattern: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const segments = path.split("/");

  return segments.some((segment) => {
    const nameWithoutExtension = segment.replace(/\.[^.]+$/, "");

    const escapedPattern = normalizedPattern.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

    const patternRegex = new RegExp(`(^|[-_.])${escapedPattern}($|[-_.])`);

    return patternRegex.test(nameWithoutExtension);
  });
}

export class ReviewPolicyEngine {
  private readonly config: z.infer<typeof PolicyConfigSchema>;

  constructor(config: ReviewPolicyConfig = {}) {
    const validation = PolicyConfigSchema.safeParse(config);

    if (!validation.success) {
      throw new ReviewPolicyError(
        "INVALID_CONFIGURATION",
        "Invalid review policy configuration.",
      );
    }

    this.config = validation.data;
  }

  evaluate(files: PolicyInputFile[]): ReviewPolicyResult {
    const eligibleFiles: PolicyInputFile[] = [];
    const excludedFiles: ExcludedFile[] = [];
    const sensitiveCategories = new Set<SensitiveCategory>();

    const seenPaths = new Set<string>();

    for (const file of files) {
      validatePath(file.filename);

      const normalizedPath = normalizePath(file.filename);

      if (seenPaths.has(normalizedPath)) {
        throw new ReviewPolicyError(
          "INVALID_FILE_PATH",
          "Duplicate changed-file paths were provided.",
        );
      }

      seenPaths.add(normalizedPath);

      const segments = normalizedPath.split("/");
      const fileName = segments[segments.length - 1];
      const extensionIndex = fileName.lastIndexOf(".");
      const extension =
        extensionIndex > 0 ? fileName.slice(extensionIndex) : "";

      let exclusionReason: ExcludedFile["reason"] | undefined;

      if (
        containsDirectory(normalizedPath, this.config.excludedDirectoryNames)
      ) {
        exclusionReason = "GENERATED_OR_DEPENDENCY_DIRECTORY";
      } else if (
        this.config.excludedFileNames.some(
          (name) => name.toLowerCase() === fileName,
        )
      ) {
        exclusionReason = "LOCK_FILE";
      } else if (
        this.config.excludedExtensions.some(
          (item) => item.toLowerCase() === extension,
        )
      ) {
        exclusionReason = "BINARY_OR_NON_SOURCE_EXTENSION";
      }

      if (exclusionReason) {
        excludedFiles.push({
          filename: file.filename,
          reason: exclusionReason,
        });

        continue;
      }

      eligibleFiles.push(file);

      for (const rule of this.config.sensitivePathRules) {
        if (
          rule.patterns.some((pattern) =>
            matchesSensitivePattern(normalizedPath, pattern),
          )
        ) {
          sensitiveCategories.add(rule.category);
        }
      }
    }

    return {
      eligibleFiles,
      excludedFiles,
      sensitiveCategories: [...sensitiveCategories].sort(),
    };
  }
}
