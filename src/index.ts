/**
 * Node and Bun entry point: analyze a git range, the index, the working tree, or two files on
 * disk. The analysis itself (`sift`) is runtime-neutral; this module adds git and the
 * filesystem. Browsers use `diffsift/browser` instead.
 */

import { readFile } from "node:fs/promises";
import { readGrammarSources } from "./node/wasm";
import { parseRevisionArgument, readGitPairs, type GitSpec } from "./node/git";
import { createParserHost, type ParserHost } from "./parser";
import { sift, type SiftOptions } from "./sift";
import type { SiftResult } from "./types";

export { sift } from "./sift";
export { createParserHost } from "./parser";
export { parseRevisionArgument, readGitPairs } from "./node/git";
export type * from "./types";
export type { GitSpec } from "./node/git";

let host: Promise<ParserHost> | null = null;

/** Parser host with the vendored grammars, created once per process. */
export function defaultParserHost(): Promise<ParserHost> {
  host ??= readGrammarSources().then(createParserHost);
  return host;
}

export interface SiftGitOptions extends Pick<SiftOptions, "maxFileBytes"> {
  /** Restrict to these pathspecs (relative to `repo`). */
  paths?: string[];
}

/** Analyze a git spec in a repository. */
export async function siftGit(repo: string, spec: GitSpec, options: SiftGitOptions = {}): Promise<SiftResult> {
  const { pairs, source, staleReferences } = await readGitPairs(repo, spec, options.paths ?? []);
  return sift(pairs, await defaultParserHost(), { source, staleReferences, maxFileBytes: options.maxFileBytes });
}

/** Analyze a CLI-style revision argument (`main..HEAD`, `A...B`, `HEAD~1`, or nothing for the working tree). */
export async function siftRevision(repo: string, argument: string | undefined, staged = false, options: SiftGitOptions = {}): Promise<SiftResult> {
  return siftGit(repo, await parseRevisionArgument(repo, argument, staged), options);
}

/** Analyze two files on disk as one pair. */
export async function siftFiles(oldPath: string, newPath: string, options: Pick<SiftOptions, "maxFileBytes"> = {}): Promise<SiftResult> {
  const [oldText, newText] = await Promise.all([readFile(oldPath, "utf8"), readFile(newPath, "utf8")]);
  return sift([{ oldPath, newPath, oldText, newText, status: "modified" }], await defaultParserHost(), {
    source: { kind: "files", diffAlgorithm: "myers" },
    maxFileBytes: options.maxFileBytes,
  });
}
