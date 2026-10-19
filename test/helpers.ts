/**
 * Shared test helpers: one parser host per test process, and shortcuts for tokenizing source.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readGrammarSources } from "../src/node/wasm";
import type { Grammar } from "../src/languages";
import { createParserHost, type ParserHost } from "../src/parser";
import { tokenize, type TokenStream } from "../src/tokens";
import type { FilePair, SiftResult } from "../src/types";

let host: Promise<ParserHost> | null = null;

/** Parser host shared by every test in the process. */
export function testParserHost(): Promise<ParserHost> {
  host ??= readGrammarSources().then(createParserHost);
  return host;
}

/** Parse and tokenize source text; throws if the text has syntax errors. */
export async function createTestTokens(text: string, grammar: Grammar = "typescript"): Promise<TokenStream> {
  const parser = await testParserHost();
  const parsed = parser.parse(grammar, text);
  try {
    if (!parsed.ok) {
      throw new Error(`test source has syntax errors:\n${text}`);
    }

    return tokenize(parsed.tree, text, grammar);
  } finally {
    parser.dispose(parsed);
  }
}

/** Comparison keys of a source text, the form equality is decided on. */
export async function testKeys(text: string, grammar: Grammar = "typescript"): Promise<string[]> {
  return (await createTestTokens(text, grammar)).tokens.map((token) => token.key);
}

/** Read a fixture's `old/` and `new/` trees into file pairs (paths relative to each tree). */
export function createTestFixturePairs(directory: string): FilePair[] {
  const read = (base: string) => {
    const files = new Map<string, string>();
    if (!existsSync(base)) return files;
    for (const path of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!path.isFile()) continue;
      const full = join(path.parentPath, path.name);
      files.set(relative(base, full).split(sep).join("/"), readFileSync(full, "utf8"));
    }
    return files;
  };

  const oldFiles = read(join(directory, "old"));
  const newFiles = read(join(directory, "new"));
  const renames: Array<{ from: string; to: string }> = existsSync(join(directory, "renames.json"))
    ? JSON.parse(readFileSync(join(directory, "renames.json"), "utf8"))
    : [];
  const pairs: FilePair[] = [];

  for (const { from, to } of renames) {
    pairs.push({ oldPath: from, newPath: to, oldText: oldFiles.get(from) ?? "", newText: newFiles.get(to) ?? "", status: "renamed", similarity: oldFiles.get(from) === newFiles.get(to) ? 100 : 50 });
    oldFiles.delete(from);
    newFiles.delete(to);
  }

  for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    const oldText = oldFiles.get(path);
    const newText = newFiles.get(path);
    if (oldText === newText) continue;
    pairs.push({
      oldPath: oldText === undefined ? null : path,
      newPath: newText === undefined ? null : path,
      oldText: oldText ?? "",
      newText: newText ?? "",
      status: oldText === undefined ? "added" : newText === undefined ? "deleted" : "modified",
    });
  }

  return pairs;
}

/** The parts of a result fixtures assert on, in a stable, readable shape. */
export function projectTestResult(result: SiftResult) {
  return {
    summary: { realLines: result.summary.realLines, byCategory: result.summary.byCategory },
    renames: result.renames.map(({ from, to, count, exported }) => ({ from, to, count, exported })),
    moves: result.moves.map((move) => ({ symbol: move.symbol, from: move.from.file, to: move.to.file, changedInside: move.changedInside })),
    realChanges: result.realChanges.map(({ file, side, line, endLine }) => `${file}:${side}:${line}${endLine === line ? "" : `-${endLine}`}`),
    formatFiles: result.formatFiles.map((file) => `${file.file} [${file.kinds.join(", ")}]`),
    lines: result.files.map((file) => ({
      file: file.newPath ?? file.oldPath,
      lines: file.lines.map((entry) => `${entry.side}:${entry.line} ${entry.category}${entry.reason && entry.reason !== "changed" ? ` (${entry.reason})` : ""}`),
    })),
    diagnostics: result.diagnostics.map((diagnostic) => `${diagnostic.file}: ${diagnostic.code}`),
  };
}
