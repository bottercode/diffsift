/**
 * Picks the tree-sitter grammar for a file path. Only TypeScript and JavaScript are analyzed in
 * v1; every other file is reported as unsupported, which makes all of its changed lines real.
 */

export type Grammar = "typescript" | "tsx" | "javascript";

export const GRAMMARS: readonly Grammar[] = ["typescript", "tsx", "javascript"];

/** Grammar for a path, or `null` when diffsift does not analyze that file type. */
export function grammarFor(path: string): Grammar | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (/\.(ts|mts|cts)$/.test(lower)) return "typescript";
  if (/\.(js|mjs|cjs|jsx)$/.test(lower)) return "javascript";
  return null;
}
