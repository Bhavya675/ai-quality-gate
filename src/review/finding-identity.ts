import { createHash } from "node:crypto";
import type { ReviewFinding } from "../validation/review-result.js";

export function generateFindingId(
  finding: Pick<ReviewFinding, "category" | "file" | "title">,
): string {
  const normalized = [
    finding.category,
    finding.file.replace(/\\/g, "/").toLowerCase(),
    finding.title.trim().toLowerCase().replace(/\s+/g, " "),
  ].join("|");

  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export interface DeduplicationResult {
  findings: ReviewFinding[];
  duplicatesRemoved: number;
}

export function deduplicateFindings(
  findings: ReviewFinding[],
): DeduplicationResult {
  const unique = new Map<string, ReviewFinding>();

  for (const finding of findings) {
    const generatedId = generateFindingId(finding);

    const existing = unique.get(generatedId);

    if (!existing) {
      unique.set(generatedId, {
        ...finding,
        id: generatedId,
      });
      continue;
    }

    // Prefer an open finding over a resolved duplicate.
    if (existing.status === "resolved" && finding.status === "open") {
      unique.set(generatedId, {
        ...finding,
        id: generatedId,
      });
    }
  }

  return {
    findings: [...unique.values()],
    duplicatesRemoved: findings.length - unique.size,
  };
}
