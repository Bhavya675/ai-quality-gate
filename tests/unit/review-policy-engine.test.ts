import { describe, expect, it } from "vitest";
import {
  ReviewPolicyEngine,
  ReviewPolicyError,
} from "../../src/review/review-policy-engine.js";

describe("ReviewPolicyEngine", () => {
  const engine = new ReviewPolicyEngine();

  it("keeps ordinary source files eligible", () => {
    const result = engine.evaluate([
      { filename: "src/orders/order-service.ts", status: "modified" },
      { filename: "src/components/order-list.ts", status: "added" },
    ]);

    expect(result.eligibleFiles).toHaveLength(2);
    expect(result.excludedFiles).toHaveLength(0);
  });

  it("excludes dependency and generated directories", () => {
    const result = engine.evaluate([
      { filename: "node_modules/library/index.js", status: "modified" },
      { filename: "dist/app.js", status: "modified" },
      { filename: "src/app.ts", status: "modified" },
    ]);

    expect(result.eligibleFiles).toHaveLength(1);
    expect(result.excludedFiles).toHaveLength(2);
  });

  it("excludes lock files", () => {
    const result = engine.evaluate([
      { filename: "package-lock.json", status: "modified" },
      { filename: "yarn.lock", status: "modified" },
    ]);

    expect(result.eligibleFiles).toHaveLength(0);
    expect(result.excludedFiles).toHaveLength(2);
    expect(
      result.excludedFiles.every((file) => file.reason === "LOCK_FILE"),
    ).toBe(true);
  });

  it("excludes configured binary file extensions", () => {
    const result = engine.evaluate([
      { filename: "assets/logo.png", status: "added" },
      { filename: "assets/font.woff2", status: "added" },
      { filename: "src/logo-service.ts", status: "modified" },
    ]);

    expect(result.eligibleFiles).toHaveLength(1);
    expect(result.excludedFiles).toHaveLength(2);
  });

  it("identifies authentication-sensitive files", () => {
    const result = engine.evaluate([
      { filename: "src/auth/auth-service.ts", status: "modified" },
    ]);

    expect(result.sensitiveCategories).toContain("auth-identity");
  });

  it("identifies financial and ledger-sensitive files", () => {
    const result = engine.evaluate([
      { filename: "src/payments/transfer-service.ts", status: "modified" },
      { filename: "src/ledger/reconciliation.ts", status: "modified" },
    ]);

    expect(result.sensitiveCategories).toContain("money-movement");
    expect(result.sensitiveCategories).toContain("ledger-reconciliation");
  });

  it("identifies multiple sensitive categories", () => {
    const result = engine.evaluate([
      { filename: "src/auth/token-service.ts", status: "modified" },
      { filename: "src/customer/profile.ts", status: "modified" },
      { filename: "src/permissions/role-service.ts", status: "modified" },
    ]);

    expect(result.sensitiveCategories).toContain("auth-identity");
    expect(result.sensitiveCategories).toContain("customer-personal-data");
    expect(result.sensitiveCategories).toContain("permissions-limits");
  });

  it("does not flag unrelated filenames containing sensitive words", () => {
    const result = engine.evaluate([
      { filename: "src/authoring/document-service.ts", status: "modified" },
    ]);

    expect(result.sensitiveCategories).not.toContain("auth-identity");
  });

  it("handles Windows-style paths", () => {
    const result = engine.evaluate([
      { filename: "src\\auth\\auth-service.ts", status: "modified" },
    ]);

    expect(result.sensitiveCategories).toContain("auth-identity");
  });

  it("rejects path traversal", () => {
    expect(() =>
      engine.evaluate([{ filename: "../secrets.txt", status: "modified" }]),
    ).toThrowError(ReviewPolicyError);
  });

  it("rejects absolute paths", () => {
    expect(() =>
      engine.evaluate([{ filename: "/etc/passwd", status: "modified" }]),
    ).toThrowError(ReviewPolicyError);
  });

  it("rejects duplicate paths regardless of casing", () => {
    expect(() =>
      engine.evaluate([
        { filename: "src/Auth.ts", status: "modified" },
        { filename: "src/auth.ts", status: "modified" },
      ]),
    ).toThrowError(ReviewPolicyError);
  });

  it("supports custom exclusion rules", () => {
    const customEngine = new ReviewPolicyEngine({
      excludedDirectoryNames: ["generated"],
      excludedFileNames: ["custom.lock"],
      excludedExtensions: [".map"],
      sensitivePathRules: [],
    });

    const result = customEngine.evaluate([
      { filename: "generated/client.ts", status: "modified" },
      { filename: "custom.lock", status: "modified" },
      { filename: "src/app.map", status: "modified" },
      { filename: "src/app.ts", status: "modified" },
    ]);

    expect(result.eligibleFiles).toHaveLength(1);
    expect(result.excludedFiles).toHaveLength(3);
  });

  it("rejects invalid policy configuration", () => {
    expect(
      () =>
        new ReviewPolicyEngine({
          excludedDirectoryNames: [""],
        }),
    ).toThrowError(ReviewPolicyError);
  });
});
