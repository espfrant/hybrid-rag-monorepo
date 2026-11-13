import { createRequire } from "node:module";
import { extname } from "node:path";
import type { SymbolType } from "@rag/shared-types";
import { PDFParse } from "pdf-parse";
import Parser from "web-tree-sitter";

type SyntaxNode = Parser.SyntaxNode;

export type SupportedCodeLanguage = "typescript" | "javascript" | "python" | "go";

export interface ExtractedChunk {
  filePath: string;
  language: string;
  symbolName: string;
  symbolType: SymbolType;
  content: string;
  startLine: number;
  endLine: number;
}

const require = createRequire(import.meta.url);

const EXTENSION_LANGUAGE_MAP: Record<string, SupportedCodeLanguage | "markdown" | "pdf"> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".md": "markdown",
  ".mdx": "markdown",
  ".pdf": "pdf",
};

const WASM_FILE_MAP: Record<SupportedCodeLanguage, string> = {
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  javascript: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
  go: "tree-sitter-wasms/out/tree-sitter-go.wasm",
};

export function detectLanguageFromPath(
  filePath: string,
): SupportedCodeLanguage | "markdown" | "pdf" | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? null;
}

function classifyNodeType(nodeType: string): SymbolType | null {
  switch (nodeType) {
    case "function_declaration":
    case "function_definition":
    case "method_definition":
    case "method_declaration":
    case "arrow_function":
    case "function_expression":
      return "function";
    case "class_declaration":
    case "class_definition":
      return "class";
    case "interface_declaration":
    case "type_alias_declaration":
    case "type_spec":
      return "interface";
    default:
      return null;
  }
}

function extractSymbolName(node: SyntaxNode): string {
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return nameNode.text;
  }

  // Handle variable declarator wrapping arrow_function: `export const foo = () => {}`
  if (node.parent?.type === "variable_declarator") {
    const varName = node.parent.childForFieldName("name");
    if (varName) {
      return varName.text;
    }
  }

  return "anonymous";
}

function collectAstChunks(
  root: SyntaxNode,
  filePath: string,
  language: SupportedCodeLanguage,
): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = [];
  const seenKeys = new Set<string>();

  const visit = (node: SyntaxNode): void => {
    const symbolType = classifyNodeType(node.type);

    if (symbolType) {
      // For exported arrow functions, prefer the full lexical/export statement line span when clean
      let spanNode = node;
      if (
        node.type === "arrow_function" &&
        node.parent?.type === "variable_declarator" &&
        node.parent.parent?.type === "lexical_declaration"
      ) {
        spanNode = node.parent.parent;
      }

      const startLine = spanNode.startPosition.row + 1;
      const endLine = spanNode.endPosition.row + 1;
      const symbolName = extractSymbolName(node);
      const dedupeKey = `${symbolName}:${startLine}:${endLine}`;

      if (!seenKeys.has(dedupeKey) && spanNode.text.trim().length > 0) {
        seenKeys.add(dedupeKey);
        chunks.push({
          filePath,
          language,
          symbolName,
          symbolType,
          content: spanNode.text,
          startLine,
          endLine,
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  };

  visit(root);
  return chunks;
}

/**
 * Splits Markdown content into heading-delimited semantic sections preserving 1-based line numbers.
 */
export function chunkMarkdown(filePath: string, content: string): ExtractedChunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || content.trim().length === 0) {
    return [];
  }

  const sections: Array<{ title: string; startLine: number; lines: string[] }> = [];
  let current: { title: string; startLine: number; lines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      if (current && current.lines.join("\n").trim().length > 0) {
        sections.push(current);
      }
      current = {
        title: headingMatch[2] ?? "Section",
        startLine: i + 1,
        lines: [line],
      };
    } else {
      if (!current) {
        current = {
          title: filePath,
          startLine: i + 1,
          lines: [],
        };
      }
      current.lines.push(line);
    }
  }

  if (current && current.lines.join("\n").trim().length > 0) {
    sections.push(current);
  }

  return sections.map((sec) => ({
    filePath,
    language: "markdown",
    symbolName: sec.title,
    symbolType: "markdown_section",
    content: sec.lines.join("\n").trimEnd(),
    startLine: sec.startLine,
    endLine: sec.startLine + sec.lines.length - 1,
  }));
}

/**
 * Splits plain text into bounded semantic blocks preserving approximate line spans.
 */
export function chunkTextBlocks(
  filePath: string,
  language: string,
  content: string,
  maxLinesPerChunk = 60,
): ExtractedChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: ExtractedChunk[] = [];

  for (let i = 0; i < lines.length; i += maxLinesPerChunk) {
    const slice = lines.slice(i, i + maxLinesPerChunk);
    const text = slice.join("\n").trim();
    if (text.length === 0) {
      continue;
    }
    chunks.push({
      filePath,
      language,
      symbolName: `${filePath}#L${i + 1}`,
      symbolType: "markdown_section",
      content: text,
      startLine: i + 1,
      endLine: i + slice.length,
    });
  }

  return chunks;
}

export class AstChunker {
  private static parserInitialized = false;
  private readonly loadedLanguages = new Map<SupportedCodeLanguage, Parser.Language>();

  private async getParserForLanguage(lang: SupportedCodeLanguage): Promise<Parser> {
    if (!AstChunker.parserInitialized) {
      await Parser.init();
      AstChunker.parserInitialized = true;
    }

    let tsLang = this.loadedLanguages.get(lang);
    if (!tsLang) {
      const wasmPath = require.resolve(WASM_FILE_MAP[lang]);
      tsLang = await Parser.Language.load(wasmPath);
      this.loadedLanguages.set(lang, tsLang);
    }

    const parser = new Parser();
    parser.setLanguage(tsLang);
    return parser;
  }

  async chunkCode(
    filePath: string,
    language: SupportedCodeLanguage,
    sourceCode: string,
  ): Promise<ExtractedChunk[]> {
    if (sourceCode.trim().length === 0) {
      return [];
    }

    const parser = await this.getParserForLanguage(language);
    const tree = parser.parse(sourceCode);
    if (!tree) {
      return chunkTextBlocks(filePath, language, sourceCode);
    }

    const astChunks = collectAstChunks(tree.rootNode, filePath, language);
    tree.delete();
    parser.delete();

    if (astChunks.length > 0) {
      return astChunks;
    }

    return chunkTextBlocks(filePath, language, sourceCode);
  }

  async chunkPdf(filePath: string, buffer: Buffer): Promise<ExtractedChunk[]> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return chunkTextBlocks(filePath, "pdf", result.text);
    } finally {
      await parser.destroy();
    }
  }

  async chunkFile(filePath: string, content: Buffer | string): Promise<ExtractedChunk[]> {
    const lang = detectLanguageFromPath(filePath);
    if (!lang) {
      return [];
    }

    if (lang === "pdf") {
      const buf = typeof content === "string" ? Buffer.from(content) : content;
      return this.chunkPdf(filePath, buf);
    }

    const text = typeof content === "string" ? content : content.toString("utf-8");
    if (lang === "markdown") {
      return chunkMarkdown(filePath, text);
    }

    return this.chunkCode(filePath, lang, text);
  }
}
