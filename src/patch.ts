/**
 * Reads the hunk ranges out of `git diff -U0` output, one entry per `diff --git` block, in
 * git's own order (the same order `git diff --raw -z` lists files with identical options).
 *
 * Only the `@@` ranges are kept: diffsift reads full file contents separately, so the patch
 * is needed just to know which lines git reports as changed. The `@@` header pattern is adapted
 * from hunk-semantic-search's `src/patch.ts`, itself adapted from Hunk (MIT, Modem Labs Inc.).
 */

export interface HunkRange {
  /** First changed old-side line (one-based); when `oldCount` is 0, the line after which lines were added. */
  oldStart: number;
  oldCount: number;
  /** First changed new-side line (one-based); when `newCount` is 0, the line after which lines were removed. */
  newStart: number;
  newCount: number;
  /** The whole `@@ … @@ …` header line. */
  header: string;
}

export interface PatchFile {
  /** Hunks in patch order. Empty for binary files, pure renames, and mode-only changes. */
  hunks: HunkRange[];
  binary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Split a multi-file `-U0` patch into per-file hunk ranges, in patch order. */
export function parsePatchFiles(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;

  for (const row of patch.split("\n")) {
    if (row.startsWith("diff --git ") || row.startsWith("diff --cc ")) {
      current = { hunks: [], binary: false };
      files.push(current);
      continue;
    }

    if (current === null) {
      continue;
    }

    if (row.startsWith("Binary files ") || row === "GIT binary patch") {
      current.binary = true;
      continue;
    }

    const hunk = parseHunkHeader(row);
    if (hunk) {
      current.hunks.push(hunk);
    }
  }

  return files;
}

/** Parse one `@@ -a,b +c,d @@` header; omitted counts mean 1. Returns `null` for other rows. */
export function parseHunkHeader(row: string): HunkRange | null {
  const match = HUNK_HEADER.exec(row);
  if (!match) {
    return null;
  }

  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    header: row,
  };
}

/** Old-side line numbers a hunk removes, one-based. */
export function oldLinesOf(hunk: HunkRange): number[] {
  return Array.from({ length: hunk.oldCount }, (_, index) => hunk.oldStart + index);
}

/** New-side line numbers a hunk adds, one-based. */
export function newLinesOf(hunk: HunkRange): number[] {
  return Array.from({ length: hunk.newCount }, (_, index) => hunk.newStart + index);
}
