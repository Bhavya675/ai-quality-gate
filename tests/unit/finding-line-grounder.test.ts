import { describe, expect, it } from "vitest";

import {
  addLineNumbers,
  groundFindingLines,
} from "../../src/review/finding-line-grounder.js";

const SOURCE = [
  "export class CartService {",
  "  applyDiscount(code: string) {",
  "    if (code === 'STAFF50') {",
  "      return this.total() * 0.5;",
  "    }",
  "  }",
  "",
  "  async checkout(): Promise<void> {",
  "    const response = await fetch(this.ordersApiUrl, {",
  "      method: 'POST',",
  "    });",
  "  }",
  "}",
].join("\n");

const file = "src/cart.service.ts";
const sources = new Map([[file, SOURCE]]);

function f(over: Record<string, unknown>) {
  return {
    file,
    line: 3,
    title: "Raw fetch bypasses interceptor",
    description: "checkout() uses the native `fetch` API.",
    evidence: "const response = await fetch(this.ordersApiUrl, {",
    ...over,
  } as {
    file: string;
    line: number;
    end_line?: number;
    title: string;
    description: string;
    evidence: string;
  };
}

describe("addLineNumbers", () => {
  it("prefixes real 1-based line numbers", () => {
    const out = addLineNumbers("a\nb\n\nd").split("\n");
    expect(out[0]).toBe("1| a");
    expect(out[3]).toBe("4| d");
  });
});

describe("groundFindingLines", () => {
  it("snaps a wrong line to the evidence line", () => {
    const [g] = groundFindingLines([f({ line: 3 })], sources);
    expect(g.line).toBe(9);
  });

  it("strips a line-number prefix the model copied into evidence", () => {
    const [g] = groundFindingLines(
      [f({ line: 3, evidence: "9|     const response = await fetch(this.ordersApiUrl, {" })],
      sources,
    );
    expect(g.line).toBe(9);
  });

  it("falls back to backticked code when evidence is prose", () => {
    const [g] = groundFindingLines(
      [f({ line: 3, evidence: "The code calls the network directly." })],
      sources,
    );
    expect(g.line).toBe(9);
  });

  it("keeps a line that already matches", () => {
    const [g] = groundFindingLines([f({ line: 9 })], sources);
    expect(g.line).toBe(9);
  });

  it("uses the full range of multi-line evidence", () => {
    const [g] = groundFindingLines(
      [
        f({
          line: 1,
          evidence:
            "const response = await fetch(this.ordersApiUrl, {\n      method: 'POST',",
        }),
      ],
      sources,
    );
    expect(g.line).toBe(9);
    expect(g.end_line).toBe(10);
  });

  it("leaves unlocatable findings and unknown files unchanged", () => {
    const unlocatable = f({ line: 4, evidence: "nothing matches here at all", description: "none", title: "none" });
    expect(groundFindingLines([unlocatable], sources)[0].line).toBe(4);
    expect(groundFindingLines([f({ file: "x.ts" })], sources)[0].line).toBe(3);
  });
});
