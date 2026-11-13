import { z } from "zod";

/**
 * Input schema for MCP tool `search_technical_docs`.
 */
export const SearchTechnicalDocsInputSchema = z.object({
  query: z.string().min(1).describe("Natural language or code search query"),
  repositoryName: z.string().min(1).optional().describe("Optional repository name filter"),
  language: z
    .string()
    .min(1)
    .optional()
    .describe("Optional language filter (e.g. typescript, python, go, markdown)"),
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(8)
    .describe("Maximum number of ranked chunks to return"),
});
export type SearchTechnicalDocsInput = z.infer<typeof SearchTechnicalDocsInputSchema>;

/**
 * Input schema for MCP tool `get_symbol_definition`.
 */
export const GetSymbolDefinitionInputSchema = z.object({
  symbolName: z.string().min(1).describe("Exact symbol identifier (function, class, interface)"),
  repositoryName: z.string().min(1).optional().describe("Optional repository name filter"),
});
export type GetSymbolDefinitionInput = z.infer<typeof GetSymbolDefinitionInputSchema>;

/**
 * Input schema for MCP tool `list_indexed_repositories`.
 */
export const ListIndexedRepositoriesInputSchema = z.object({});
export type ListIndexedRepositoriesInput = z.infer<typeof ListIndexedRepositoriesInputSchema>;
