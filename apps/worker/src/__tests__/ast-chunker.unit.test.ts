import { describe, expect, it } from "vitest";
import { AstChunker, chunkMarkdown } from "../chunker/ast-chunker.js";

describe("@rag/worker AstChunker", () => {
  const chunker = new AstChunker();

  it("extracts TypeScript functions, classes, and interfaces with exact startLine and endLine", async () => {
    const tsCode = [
      "export interface SearchOptions {",
      "  topK: number;",
      "}",
      "",
      "export class SearchEngine {",
      "  execute(query: string): string {",
      "    return query.trim();",
      "  }",
      "}",
      "",
      "export function computeScore(rank: number): number {",
      "  return 1 / (60 + rank);",
      "}",
    ].join("\n");

    const chunks = await chunker.chunkFile("src/search.ts", tsCode);

    const iface = chunks.find((c) => c.symbolName === "SearchOptions");
    expect(iface).toBeDefined();
    expect(iface?.symbolType).toBe("interface");
    expect(iface?.startLine).toBe(1);
    expect(iface?.endLine).toBe(3);

    const cls = chunks.find((c) => c.symbolName === "SearchEngine");
    expect(cls).toBeDefined();
    expect(cls?.symbolType).toBe("class");
    expect(cls?.startLine).toBe(5);
    expect(cls?.endLine).toBe(9);

    const method = chunks.find((c) => c.symbolName === "execute");
    expect(method).toBeDefined();
    expect(method?.symbolType).toBe("function");
    expect(method?.startLine).toBe(6);
    expect(method?.endLine).toBe(8);

    const fn = chunks.find((c) => c.symbolName === "computeScore");
    expect(fn).toBeDefined();
    expect(fn?.symbolType).toBe("function");
    expect(fn?.startLine).toBe(11);
    expect(fn?.endLine).toBe(13);
  });

  it("extracts Python and Go functions with exact line spans", async () => {
    const pyCode = [
      "class VectorStore:",
      "    def search(self, query):",
      "        return [query]",
      "",
      "def normalize_score(val):",
      "    return val * 2",
    ].join("\n");

    const pyChunks = await chunker.chunkFile("app/store.py", pyCode);
    const pyFn = pyChunks.find((c) => c.symbolName === "normalize_score");
    expect(pyFn).toBeDefined();
    expect(pyFn?.language).toBe("python");
    expect(pyFn?.startLine).toBe(5);
    expect(pyFn?.endLine).toBe(6);

    const goCode = [
      "package main",
      "",
      "func HybridRank(k int) int {",
      "    return k + 60",
      "}",
    ].join("\n");

    const goChunks = await chunker.chunkFile("cmd/rank.go", goCode);
    const goFn = goChunks.find((c) => c.symbolName === "HybridRank");
    expect(goFn).toBeDefined();
    expect(goFn?.language).toBe("go");
    expect(goFn?.startLine).toBe(3);
    expect(goFn?.endLine).toBe(5);
  });

  it("splits Markdown documents by headings preserving line numbers", () => {
    const md = [
      "# Overview",
      "Intro paragraph.",
      "",
      "## Hybrid RRF",
      "Uses rank_constant = 60.",
    ].join("\n");

    const sections = chunkMarkdown("README.md", md);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.symbolName).toBe("Overview");
    expect(sections[0]?.startLine).toBe(1);
    expect(sections[0]?.endLine).toBe(3);
    expect(sections[1]?.symbolName).toBe("Hybrid RRF");
    expect(sections[1]?.startLine).toBe(4);
    expect(sections[1]?.endLine).toBe(5);
  });
});
