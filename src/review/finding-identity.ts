import { createHash } from "node:crypto";
import type { ReviewFinding } from "../validation/review-result.js";

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
  NIT: 1,
  WORTH_A_LOOK: 2,
  BLOCKER: 3,
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "of",
  "and",
  "or",
  "with",
  "without",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "function",
  "method",
  "value",
  "check",
  "checks",
  "validation",
  "validate",
  "validates",
  "user",
  "userid",
  "any",
  "all",
  "every",
  "regardless",
  "provided",
  "supplied",
  "given",
  "consequently",
  "therefore",
  "allows",
  "allowing",
  "complete",
  "issue",
  "finding",
  "findings",
  "blocker",
  "blockers",
  "worth",
  "look",
  "nit",
  "nits",
  "resolved",
  "open",
  "new",
]);

const TOKEN_ALIASES: Record<string, string> = {
  administrators: "admin",
  administrator: "admin",
  administrative: "admin",

  authorization: "auth",
  authorisation: "auth",
  unauthorized: "auth",
  unauthorised: "auth",
  permission: "auth",
  permissions: "auth",
  privilege: "auth",
  privileges: "auth",
  access: "auth",

  bypasses: "bypass",
  bypassing: "bypass",
  bypassed: "bypass",
  circumvents: "bypass",
  circumvent: "bypass",

  hardcoded: "hardcode",
  hardcoding: "hardcode",
  hardcodes: "hardcode",

  returns: "return",
  returned: "return",
  returning: "return",

  unconditionally: "unconditional",
  always: "unconditional",
};

const ISSUE_SIGNAL_TOKENS = new Set([
  "hardcode",
  "true",
  "return",
  "bypass",
  "unconditional",
  "auth",
  "admin",
]);

function normalizeRepositoryPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .toLowerCase();
}

function getFindingText(finding: ReviewFinding): string {
  return [
    finding.title,
    finding.description,
    finding.impact,
    finding.suggested_fix,
    finding.evidence,
  ].join(" ");
}

function extractCodeSymbols(finding: ReviewFinding): Set<string> {
  const text = getFindingText(finding);

  const identifiers = text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];

  return new Set(
    identifiers
      // Require camelCase identifiers rather than ordinary English words.
      .filter((identifier) => /[a-z][A-Z]/.test(identifier))
      .map((identifier) => identifier.toLowerCase()),
  );
}

function extractIssueSignals(finding: ReviewFinding): Set<string> {
  const camelCaseNormalized = getFindingText(finding).replace(
    /([a-z0-9])([A-Z])/g,
    "$1 $2",
  );

  const tokens = camelCaseNormalized.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  return new Set(
    tokens
      .filter((token) => !STOP_WORDS.has(token))
      .map((token) => TOKEN_ALIASES[token] ?? token)
      .filter((token) => ISSUE_SIGNAL_TOKENS.has(token)),
  );
}

function areLocationsNearby(
  first: ReviewFinding,
  second: ReviewFinding,
): boolean {
  const firstStart = first.line;
  const firstEnd = first.end_line ?? first.line;

  const secondStart = second.line;
  const secondEnd = second.end_line ?? second.line;

  let distance = 0;

  if (firstEnd < secondStart) {
    distance = secondStart - firstEnd;
  } else if (secondEnd < firstStart) {
    distance = firstStart - secondEnd;
  }

  return distance <= 3;
}

export function generateFindingId(
  finding: Pick<ReviewFinding, "category" | "file" | "title">,
): string {
  const normalized = [
    finding.category,
    normalizeRepositoryPath(finding.file),
    finding.title.trim().toLowerCase().replace(/\s+/g, " "),
  ].join("|");

  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Conservatively identifies likely duplicate findings.
 *
 * Exact IDs retain the existing stable-identity behavior.
 * Paraphrased findings require the same file, category, nearby
 * location, a shared code symbol, and at least two shared
 * issue signals.
 */
export function areEquivalentFindings(
  first: ReviewFinding,
  second: ReviewFinding,
): boolean {
  if (first.category !== second.category) {
    return false;
  }

  if (
    normalizeRepositoryPath(first.file) !== normalizeRepositoryPath(second.file)
  ) {
    return false;
  }

  // Exact identity remains authoritative.
  if (generateFindingId(first) === generateFindingId(second)) {
    return true;
  }

  if (!areLocationsNearby(first, second)) {
    return false;
  }

  const firstSymbols = extractCodeSymbols(first);
  const secondSymbols = extractCodeSymbols(second);

  const hasSharedCodeSymbol = [...firstSymbols].some((symbol) =>
    secondSymbols.has(symbol),
  );

  if (!hasSharedCodeSymbol) {
    return false;
  }

  const firstSignals = extractIssueSignals(first);
  const secondSignals = extractIssueSignals(second);

  const sharedSignalCount = [...firstSignals].filter((signal) =>
    secondSignals.has(signal),
  ).length;

  return sharedSignalCount >= 2;
}

function findingQuality(finding: ReviewFinding): number {
  return (
    finding.title.length +
    finding.description.length +
    finding.impact.length +
    finding.suggested_fix.length +
    finding.evidence.length
  );
}

function choosePreferredFinding(
  existing: ReviewFinding,
  candidate: ReviewFinding,
): ReviewFinding {
  // An open finding must never be suppressed by a resolved duplicate.
  if (candidate.status === "open" && existing.status === "resolved") {
    return candidate;
  }

  if (candidate.status === "resolved" && existing.status === "open") {
    return existing;
  }

  // Keep the highest severity.
  const existingSeverity = SEVERITY_RANK[existing.severity];
  const candidateSeverity = SEVERITY_RANK[candidate.severity];

  if (candidateSeverity > existingSeverity) {
    return candidate;
  }

  if (candidateSeverity < existingSeverity) {
    return existing;
  }

  // Prefer the more informative finding when severity and status match.
  return findingQuality(candidate) > findingQuality(existing)
    ? candidate
    : existing;
}

export interface DeduplicationResult {
  findings: ReviewFinding[];
  duplicatesRemoved: number;
}

export function deduplicateFindings(
  findings: ReviewFinding[],
): DeduplicationResult {
  const unique: ReviewFinding[] = [];

  for (const finding of findings) {
    const normalizedFinding: ReviewFinding = {
      ...finding,
      id: generateFindingId(finding),
    };

    const duplicateIndex = unique.findIndex((existing) =>
      areEquivalentFindings(existing, normalizedFinding),
    );

    if (duplicateIndex === -1) {
      unique.push(normalizedFinding);
      continue;
    }

    const existing = unique[duplicateIndex];

    const preferred = choosePreferredFinding(existing, normalizedFinding);

    // Preserve the original server-side identity.
    unique[duplicateIndex] = {
      ...preferred,
      id: existing.id,
    };
  }

  return {
    findings: unique,
    duplicatesRemoved: findings.length - unique.length,
  };
}
