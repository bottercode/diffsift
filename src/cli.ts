#!/usr/bin/env node
/**
 * The `diffsift` command. `diffsift [range]` analyzes git changes (no range: working tree vs
 * HEAD, including untracked files), `--staged` the index, `--files a b` two files on disk, and
 * `diffsift mcp` starts the MCP server for coding agents. Prints a readable report by default
 * and schema v1 JSON with `--json`.
 */

import { parseArgs } from "node:util";
import { defaultParserHost, readGitPairs, parseRevisionArgument } from "./index";
import { renderText, shouldColor } from "./render";
import { sift } from "./sift";
import type { Category, FilePair, SiftResult } from "./types";
import { readFile } from "node:fs/promises";

const VERSION = "0.1.0";

const HELP = `diffsift ${VERSION}: separate the real changes in a TypeScript/JavaScript diff from formatting, renames, and moved code

Usage:
  diffsift [<range>] [-- <paths>...]   git changes (default: working tree vs HEAD, plus untracked files)
  diffsift --staged [<rev>]            staged changes
  diffsift --files <old> <new>         two files on disk
  diffsift mcp                         start the MCP server (stdio)

Ranges: main..HEAD, main...HEAD (since the merge base), HEAD~3 (vs working tree)

Options:
  --json             print schema v1 JSON
  --only real        show only real changes (text output)
  --exit-code        exit 1 when there are real changes or unanalyzed files
  --repo <dir>       repository directory (default: current directory)
  --max-file-bytes   skip files larger than this (default 1000000)
  --color, --no-color
  -h, --help, -v, --version
`;

/** Parse arguments and run; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "mcp") {
    const { startMcpServer } = await import("./mcp");
    await startMcpServer();
    return -1;
  }

  const separator = argv.indexOf("--");
  const paths = separator === -1 ? [] : argv.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: separator === -1 ? argv : argv.slice(0, separator),
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      staged: { type: "boolean" },
      files: { type: "boolean" },
      only: { type: "string" },
      "exit-code": { type: "boolean" },
      repo: { type: "string" },
      "max-file-bytes": { type: "string" },
      color: { type: "boolean" },
      "no-color": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.only !== undefined && !["real", "format", "comment", "rename", "move"].includes(values.only)) {
    throw new Error(`--only must be one of real, format, comment, rename, move`);
  }

  const repo = values.repo ?? process.cwd();
  const maxFileBytes = values["max-file-bytes"] === undefined ? undefined : Number(values["max-file-bytes"]);
  const { result, pairs } = values.files
    ? await siftFilePositionals(positionals, maxFileBytes)
    : await siftGitPositionals(repo, positionals, Boolean(values.staged), paths, maxFileBytes);

  if (values.json) {
    process.stdout.write(`${JSON.stringify(filterOnly(result, values.only as Category | undefined), null, 2)}\n`);
  } else {
    const color = shouldColor(values["no-color"] ? false : values.color, Boolean(process.stdout.isTTY), process.env);
    process.stdout.write(renderText(result, { color, pairs, onlyReal: values.only === "real" }));
  }

  if (values["exit-code"] && (result.summary.realLines > 0 || result.diagnostics.length > 0)) {
    return 1;
  }

  return 0;
}

/** Git mode from positional arguments. */
async function siftGitPositionals(repo: string, positionals: string[], staged: boolean, paths: string[], maxFileBytes: number | undefined) {
  if (positionals.length > 1) throw new Error(`expected at most one range, got ${positionals.join(" ")}`);
  const spec = await parseRevisionArgument(repo, positionals[0], staged);
  const { pairs, source, staleReferences } = await readGitPairs(repo, spec, paths);
  const result = await sift(pairs, await defaultParserHost(), { source, staleReferences, maxFileBytes });
  return { result, pairs };
}

/** Files mode from positional arguments. */
async function siftFilePositionals(positionals: string[], maxFileBytes: number | undefined): Promise<{ result: SiftResult; pairs: FilePair[] }> {
  if (positionals.length !== 2) throw new Error("--files takes exactly two paths: <old> <new>");
  const [oldPath, newPath] = positionals as [string, string];
  const [oldText, newText] = await Promise.all([readFile(oldPath, "utf8"), readFile(newPath, "utf8")]);
  const pairs: FilePair[] = [{ oldPath, newPath, oldText, newText, status: "modified" }];
  const result = await sift(pairs, await defaultParserHost(), { source: { kind: "files", diffAlgorithm: "myers" }, maxFileBytes });
  return { result, pairs };
}

/** `--only <category>` keeps only that category's line entries (and real changes for `real`). */
function filterOnly(result: SiftResult, only: Category | undefined): SiftResult {
  if (!only) return result;
  return {
    ...result,
    files: result.files.map((file) => ({ ...file, lines: file.lines.filter((entry) => entry.category === only) })),
    realChanges: only === "real" ? result.realChanges : [],
  };
}

const isEntry = (() => {
  try {
    return import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname;
  } catch {
    return false;
  }
})();

if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`diffsift: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
