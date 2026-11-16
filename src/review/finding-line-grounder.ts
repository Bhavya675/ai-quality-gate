const LINE_PREFIX = /^\s*\d+\|\s?/;
const MIN_ANCHOR_CHARS = 6;
const MAX_TOKEN_MATCHES = 5;

/** `  35| code` — lets the model read real line numbers instead of counting. */
export function addLineNumbers(content: string): string {
  const lines = content.split(/\r?\n/);
  const width = String(lines.length).length;

  return lines
    .map((line, index) => `${String(index + 1).padStart(width, " ")}| ${line}`)
    .join("\n");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function closestTo(indices: number[], statedIndex: number): number {
  return indices.reduce((best, current) =>
    Math.abs(current - statedIndex) < Math.abs(best - statedIndex)
      ? current
      : best,
  );
}

interface GroundableFinding {
  file: string;
  line: number;
  end_line?: number;
  title: string;
  description: string;
  evidence: string;
}

/**
 * The model's line numbers are only a hint. Snap each finding to the line
 * where its evidence (or the code it names in backticks) really is.
 * Findings that cannot be located keep the model's original position.
 */
export function groundFindingLines<T extends GroundableFinding>(
  findings: T[],
  sourceByPath: ReadonlyMap<string, string>,
): T[] {
  const normalizedSources = new Map(
    [...sourceByPath].map(([path, content]) => [normalizePath(path), content]),
  );

  return findings.map((finding) => {
    const content = normalizedSources.get(normalizePath(finding.file));

    if (content === undefined) {
      return finding;
    }

    const fileLines = content.split(/\r?\n/);
    const normalizedLines = fileLines.map(normalizeText);
    const statedIndex = finding.line - 1;
    const statedText = normalizedLines[statedIndex] ?? "";
    const span =
      finding.end_line !== undefined ? finding.end_line - finding.line : 0;

    const evidenceLines = finding.evidence
      .split(/\r?\n/)
      .map((line) => normalizeText(line.replace(LINE_PREFIX, "")))
      .filter((line) => line.length >= MIN_ANCHOR_CHARS);

    const tokens = [
      ...new Set(
        [...`${finding.title}\n${finding.description}\n${finding.evidence}`.matchAll(
          /`([^`\n]{3,80})`/g,
        )].map((match) => match[1].trim()),
      ),
    ].sort((a, b) => b.length - a.length);

    // Already pointing at the evidence or a named token: keep it.
    if (
      statedText.length >= MIN_ANCHOR_CHARS &&
      (evidenceLines.some((line) => statedText.includes(line)) ||
        tokens.some((token) => fileLines[statedIndex]?.includes(token)))
    ) {
      return finding;
    }

    let foundIndex: number | null = null;
    let foundSpan = span;

    if (evidenceLines.length > 0) {
      const matches = normalizedLines
        .map((line, index) => (line.includes(evidenceLines[0]) ? index : -1))
        .filter((index) => index >= 0);

      if (matches.length > 0) {
        foundIndex = closestTo(matches, statedIndex);

        const contiguous = evidenceLines.every((line, offset) =>
          normalizedLines[foundIndex! + offset]?.includes(line),
        );

        if (contiguous && evidenceLines.length > 1) {
          foundSpan = evidenceLines.length - 1;
        }
      }
    }

    if (foundIndex === null) {
      for (const token of tokens) {
        const matches = fileLines
          .map((line, index) => (line.includes(token) ? index : -1))
          .filter((index) => index >= 0);

        if (matches.length > 0 && matches.length <= MAX_TOKEN_MATCHES) {
          foundIndex = closestTo(matches, statedIndex);
          break;
        }
      }
    }

    if (foundIndex === null) {
      return finding;
    }

    const line = foundIndex + 1;
    const endLine = Math.min(line + foundSpan, fileLines.length);
    const { end_line: _ignored, ...rest } = finding;

    return (endLine > line ? { ...rest, line, end_line: endLine } : { ...rest, line }) as T;
  });
}
