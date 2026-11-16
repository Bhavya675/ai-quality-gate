import type {
  FindingSeverity,
  ReviewFinding,
} from "../validation/review-result.js";

export const RESULT_MARKER = "<!-- AI_QUALITY_GATE_RESULT -->";

export interface ResultCommentInput {
  verdict: "PASS" | "FAIL";
  summary: string;
  reviewComplete: boolean;
  headSha: string;
  findings: ReviewFinding[];
  sensitiveCategories: string[];
  serverUrl: string;
  owner: string;
  repository: string;
  workflowRunUrl?: string;
  /** finding id -> URL of its inline review comment */
  inlineCommentUrls?: ReadonlyMap<string, string>;
}

const SEVERITY_ICON: Record<FindingSeverity, string> = {
  BLOCKER: "🛑",
  WORTH_A_LOOK: "👀",
  NIT: "🧹",
};

/** Escapes untrusted AI text: no HTML, no table breaks, no @mentions. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/@/g, "@\u200b")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(value: string, max = 70): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function buildFileUrl(
  input: Pick<ResultCommentInput, "serverUrl" | "owner" | "repository" | "headSha">,
  finding: Pick<ReviewFinding, "file" | "line" | "end_line">,
): string {
  const path = finding.file
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const anchor =
    finding.end_line && finding.end_line > finding.line
      ? `#L${finding.line}-L${finding.end_line}`
      : `#L${finding.line}`;

  return `${input.serverUrl}/${input.owner}/${input.repository}/blob/${input.headSha}/${path}${anchor}`;
}

function findingBullet(input: ResultCommentInput, finding: ReviewFinding): string {
  const label = `${escapeText(finding.file)}:${finding.line}`;
  const fileUrl = buildFileUrl(input, finding);
  const commentUrl = input.inlineCommentUrls?.get(finding.id);
  // The main link opens the inline review comment; ↗ opens the file.
  const link = `[\`${label.replace(/`/g, "")}\`](${commentUrl ?? fileUrl})`;
  const fileLink = commentUrl ? ` · [↗](${fileUrl})` : "";

  return `- **${escapeText(finding.title)}** · ${link}${fileLink}`;
}

type CheckRow = { label: string; category: ReviewFinding["category"] };

const CHECK_ROWS: CheckRow[] = [
  { label: "Reviews", category: "human-feedback" },
  { label: "Tests", category: "testing" },
  { label: "Observability", category: "observability" },
];

function checkRow(open: ReviewFinding[], row: CheckRow): string {
  const inCategory = open.filter((f) => f.category === row.category);
  const blocker = inCategory.find((f) => f.severity === "BLOCKER");

  if (blocker) {
    return `❌ ${row.label}: ${escapeText(shorten(blocker.title))}`;
  }

  if (inCategory.length > 0) {
    return `⚠️ ${row.label}: ${escapeText(shorten(inCategory[0].title))}`;
  }

  return `✅ ${row.label}`;
}

export function renderResultComment(input: ResultCommentInput): string {
  const open = input.findings.filter((f) => f.status === "open");
  const resolved = input.findings.filter((f) => f.status === "resolved");

  const blockers = open.filter((f) => f.severity === "BLOCKER");
  const worthALook = open.filter((f) => f.severity === "WORTH_A_LOOK");
  const nits = open.filter((f) => f.severity === "NIT");

  const heading = !input.reviewComplete
    ? "⚠️ AI quality gate: review incomplete"
    : input.verdict === "PASS"
      ? "✅ AI quality gate: ready to merge"
      : "❌ AI quality gate: not ready to merge";

  const lines: string[] = [
    RESULT_MARKER,
    `## ${heading}`,
    "",
    escapeText(input.summary),
    "",
    CHECK_ROWS.map((row) => checkRow(open, row)).join(" · "),
    "",
  ];

  if (blockers.length > 0) {
    lines.push(
      `### ${SEVERITY_ICON.BLOCKER} Must fix before merge`,
      "",
      ...blockers.map((f) => findingBullet(input, f)),
      "",
    );
  }

  if (worthALook.length > 0) {
    lines.push(
      `### ${SEVERITY_ICON.WORTH_A_LOOK} Worth a look`,
      "",
      ...worthALook.map((f) => findingBullet(input, f)),
      "",
    );
  }

  if (nits.length > 0) {
    lines.push(
      "<details>",
      `<summary>${SEVERITY_ICON.NIT} ${nits.length} nit${nits.length === 1 ? "" : "s"}</summary>`,
      "",
      ...nits.map((f) => findingBullet(input, f)),
      "",
      "</details>",
      "",
    );
  }

  if (resolved.length > 0) {
    lines.push(
      "<details>",
      `<summary>✅ ${resolved.length} resolved</summary>`,
      "",
      ...resolved.map((f) => `- ~~${escapeText(f.title)}~~ · \`${escapeText(f.file)}:${f.line}\``),
      "",
      "</details>",
      "",
    );
  }

  if (open.length === 0 && resolved.length === 0) {
    lines.push("No findings were reported.", "");
  }

  const footer: string[] = [];

  if (input.workflowRunUrl) {
    footer.push(`[Workflow run](${input.workflowRunUrl})`);
  }

  footer.push(`reviewed \`${input.headSha.slice(0, 7)}\``);

  if (input.sensitiveCategories.length > 0) {
    footer.push(`sensitive: ${input.sensitiveCategories.join(", ")}`);
  }

  lines.push(`<sub>${footer.join(" · ")}</sub>`);

  return lines.join("\n");
}
