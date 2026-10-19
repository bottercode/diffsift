/**
 * Reads file pairs for a git range, the index, or the working tree, using git's own rename
 * detection and `-U0` hunks so diffsift's changed lines are exactly the lines git (and the diff
 * viewers built on it) show as changed.
 *
 * Git runs without a shell, revisions starting with `-` are rejected, and `--end-of-options`
 * always precedes revisions, so a range coming from an agent cannot inject options. Contents
 * come from one `git cat-file --batch` process; the working tree side is read from disk.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { grammarFor } from "../languages";
import { lineHunks } from "../lines";
import { parsePatchFiles } from "../patch";
import type { FilePair, FileStatus, SiftResult } from "../types";

export type GitSpec =
  | { kind: "range"; base: string; head: string }
  | { kind: "staged"; base?: string }
  | { kind: "worktree"; base: string; untracked: boolean };

export interface GitPairs {
  pairs: FilePair[];
  source: SiftResult["source"];
  /** Unchanged files at the head revision (or in the working tree) that mention a name. */
  staleReferences: (name: string) => Promise<string[]>;
}

const DIFF_ALGORITHM = "myers";
const SUPPORTED_GLOBS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/** Run git and return stdout; throws with git's stderr on failure. */
export function runGit(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args.join(" ")} failed: ${Buffer.concat(err).toString().trim()}`));
    });
    child.stdin.end(input ?? "");
  });
}

/** Turn a CLI-style revision argument into a spec: `A..B`, `A...B` (merge base), or one revision vs the working tree. */
export async function parseRevisionArgument(repo: string, argument: string | undefined, staged: boolean): Promise<GitSpec> {
  if (argument !== undefined) assertRevision(argument);
  if (staged) return { kind: "staged", ...(argument ? { base: argument } : {}) };
  if (argument === undefined) return { kind: "worktree", base: "HEAD", untracked: true };

  const threeDots = argument.indexOf("...");
  if (threeDots !== -1) {
    const left = argument.slice(0, threeDots) || "HEAD";
    const right = argument.slice(threeDots + 3) || "HEAD";
    assertRevision(left);
    assertRevision(right);
    const base = (await runGit(repo, ["merge-base", "--end-of-options", left, right])).toString().trim();
    return { kind: "range", base, head: right };
  }

  const twoDots = argument.indexOf("..");
  if (twoDots !== -1) {
    const left = argument.slice(0, twoDots) || "HEAD";
    const right = argument.slice(twoDots + 2) || "HEAD";
    assertRevision(left);
    assertRevision(right);
    return { kind: "range", base: left, head: right };
  }

  return { kind: "worktree", base: argument, untracked: false };
}

/** Refuse revisions that git would read as options. */
function assertRevision(revision: string) {
  if (revision.startsWith("-") || revision.includes("\0")) {
    throw new Error(`refusing revision ${JSON.stringify(revision)}`);
  }
}

/** Read every changed file pair for a spec, with git's hunks. */
export async function readGitPairs(repo: string, spec: GitSpec, paths: string[] = []): Promise<GitPairs> {
  const top = (await runGit(repo, ["rev-parse", "--show-toplevel"])).toString().trim();
  const revisions = spec.kind === "range" ? [spec.base, spec.head] : spec.kind === "staged" ? [spec.base ?? "HEAD"] : [spec.base];
  revisions.forEach(assertRevision);
  const scope = paths.length > 0 ? ["--", ...paths] : [];
  const common = ["-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-color", "-M"];
  const target = [...(spec.kind === "staged" ? ["--cached"] : []), "--end-of-options", ...revisions];

  // Pathspecs are relative to the caller's directory, while git always prints repository-root
  // paths, so the diff runs in `repo` and everything after it uses `top`.
  const [raw, patch] = await Promise.all([
    runGit(repo, [...common, "--raw", "-z", "--no-abbrev", ...target, ...scope]),
    runGit(repo, [...common, "-U0", `--diff-algorithm=${DIFF_ALGORITHM}`, ...target, ...scope]),
  ]);

  const entries = parseRaw(raw.toString("utf8"));
  const patches = parsePatchFiles(patch.toString("utf8"));
  const blobs = await readBlobs(top, entries.flatMap((entry) => [entry.oldSha, entry.newSha]).filter((sha) => !isNullSha(sha)));
  const pairs: FilePair[] = [];

  for (const [index, entry] of entries.entries()) {
    const patchFile = patches.length === entries.length ? patches[index] : undefined;
    const oldBytes = isNullSha(entry.oldSha) ? Buffer.alloc(0) : blobs.get(entry.oldSha) ?? Buffer.alloc(0);
    const newBytes = isNullSha(entry.newSha)
      ? entry.status === "deleted"
        ? Buffer.alloc(0)
        : await readFile(join(top, entry.newPath!)).catch(() => Buffer.alloc(0))
      : blobs.get(entry.newSha) ?? Buffer.alloc(0);
    const binary = patchFile?.binary === true || entry.submodule || isBinary(oldBytes) || isBinary(newBytes);
    const oldText = oldBytes.toString("utf8");
    const newText = newBytes.toString("utf8");

    pairs.push({
      oldPath: entry.status === "added" ? null : entry.oldPath,
      newPath: entry.status === "deleted" ? null : entry.newPath,
      oldText,
      newText,
      status: entry.status,
      ...(entry.similarity === undefined ? {} : { similarity: entry.similarity }),
      hunks: patchFile ? patchFile.hunks : lineHunks(oldText, newText),
      binary,
    });
  }

  if (spec.kind === "worktree" && spec.untracked && paths.length === 0) {
    const untracked = (await runGit(top, ["ls-files", "--others", "--exclude-standard", "-z"])).toString("utf8").split("\0").filter(Boolean);
    for (const path of untracked) {
      const bytes = await readFile(join(top, path)).catch(() => Buffer.alloc(0));
      const text = bytes.toString("utf8");

      // A path removed from the index (`git rm --cached`) but still on disk shows up both as a
      // deletion and as untracked; against the base it is one modified file, so pair them.
      const deletedIndex = pairs.findIndex((pair) => pair.status === "deleted" && pair.oldPath === path);
      const deleted = pairs[deletedIndex];
      if (deleted) {
        pairs[deletedIndex] = {
          ...deleted,
          newPath: path,
          newText: text,
          status: "modified",
          hunks: lineHunks(deleted.oldText, text),
          binary: deleted.binary || isBinary(bytes),
        };
        continue;
      }

      pairs.push({ oldPath: null, newPath: path, oldText: "", newText: text, status: "added", hunks: lineHunks("", text), binary: isBinary(bytes) });
    }
  }

  const head = spec.kind === "range" ? spec.head : undefined;
  return {
    pairs,
    source: {
      kind: spec.kind,
      base: revisions[0],
      ...(head ? { head } : {}),
      diffAlgorithm: DIFF_ALGORITHM,
    },
    staleReferences: (name) => grepWord(top, name, spec.kind === "range" ? spec.head : spec.kind === "staged" ? ":0" : null),
  };
}

interface RawEntry {
  status: FileStatus;
  oldPath: string;
  newPath: string;
  oldSha: string;
  newSha: string;
  similarity?: number;
  submodule: boolean;
}

/** Parse `git diff --raw -z` output. */
function parseRaw(raw: string): RawEntry[] {
  const fields = raw.split("\0");
  const entries: RawEntry[] = [];
  let index = 0;

  while (index < fields.length) {
    const header = fields[index++];
    if (!header || !header.startsWith(":")) continue;
    const [oldMode, newMode, oldSha, newSha, statusField] = header.slice(1).split(" ") as [string, string, string, string, string];
    const letter = statusField[0];
    const score = statusField.length > 1 ? Number(statusField.slice(1)) : undefined;
    const first = fields[index++] ?? "";
    const second = letter === "R" || letter === "C" ? fields[index++] ?? "" : first;
    const status: FileStatus = letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed" : letter === "C" ? "copied" : "modified";

    entries.push({
      status,
      oldPath: first,
      newPath: second,
      oldSha,
      newSha,
      ...(score === undefined ? {} : { similarity: score }),
      submodule: oldMode === "160000" || newMode === "160000",
    });
  }

  return entries;
}

/** Read blobs by sha through one `git cat-file --batch`. */
async function readBlobs(cwd: string, shas: string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(shas)];
  const blobs = new Map<string, Buffer>();
  if (unique.length === 0) return blobs;

  const output = await runGit(cwd, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) break;
    const header = output.subarray(offset, newline).toString("utf8");
    const [sha, type, size] = header.split(" ");
    offset = newline + 1;
    if (type === "missing" || size === undefined) continue;
    const length = Number(size);
    blobs.set(sha!, output.subarray(offset, offset + length));
    offset += length + 1;
  }

  return blobs;
}

/** Unchanged supported files that mention `name` as a word, at a revision or in the working tree. */
async function grepWord(cwd: string, name: string, revision: string | null): Promise<string[]> {
  const args = ["grep", "-l", "-w", "-I", "-F", "-e", name];
  if (revision && revision !== ":0") args.push("--end-of-options", revision);
  if (revision === ":0") args.push("--cached");
  args.push("--", ...SUPPORTED_GLOBS);

  try {
    const output = (await runGit(cwd, args)).toString("utf8");
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => (revision && revision !== ":0" && line.startsWith(`${revision}:`) ? line.slice(revision.length + 1) : line))
      .filter((path) => grammarFor(path) !== null);
  } catch {
    // `git grep` exits 1 when nothing matches.
    return [];
  }
}

/** True for git's all-zero sha (missing side or working tree). */
function isNullSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

/** Treat content with NUL bytes as binary, like git. */
function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}
