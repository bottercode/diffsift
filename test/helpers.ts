/**
 * Shared test helpers: one parser host per test process, and shortcuts for tokenizing source.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
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

/** Run git in a test repository and fail loudly on errors. */
export function testGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** Write a map of relative paths to contents under a directory. */
export function writeTestTree(root: string, files: Record<string, string | Uint8Array>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * Build a temporary repository with a fixture's `old/` tree committed as `base` and its `new/`
 * tree committed on top as `head`. Returns the repo root and a cleanup function.
 */
export function createTestRepo(fixtureDirectory: string, extra: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "diffsift-repo-")));
  testGit(root, "init", "-q", "-b", "main");
  const copyTree = (from: string) => {
    if (!existsSync(from)) return;
    for (const entry of readdirSync(from, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = join(entry.parentPath, entry.name);
      writeTestTree(root, { [relative(from, full).split(sep).join("/")]: readFileSync(full) });
    }
  };

  copyTree(join(fixtureDirectory, "old"));
  writeTestTree(root, extra);
  testGit(root, "add", "-A");
  testGit(root, "commit", "-q", "-m", "base");
  testGit(root, "tag", "base");

  for (const entry of readdirSync(root)) {
    if (entry !== ".git") rmSync(join(root, entry), { recursive: true, force: true });
  }
  copyTree(join(fixtureDirectory, "new"));
  // Extra files stay byte-identical, so they are unchanged files outside the change set.
  writeTestTree(root, extra);
  testGit(root, "add", "-A");
  testGit(root, "commit", "-q", "-m", "head");

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
