/**
 * Maps between string offsets and one-based line numbers the way git counts lines: only `\n`
 * ends a line, so a `\r` before it stays part of the line, exactly as in git's patch output.
 * Also computes line-level change ranges for files mode, where there is no git patch.
 */

import { myersDiff } from "./myers";
import type { HunkRange } from "./patch";

export interface LineIndex {
  /** Offset where each line starts; `starts[0] === 0`. */
  starts: number[];
  /** Number of lines; a trailing newline does not open an extra empty line. */
  count: number;
}

/** Index the line starts of a text. */
export function indexLines(text: string): LineIndex {
  const starts = [0];
  for (let offset = text.indexOf("\n"); offset !== -1; offset = text.indexOf("\n", offset + 1)) {
    starts.push(offset + 1);
  }

  const endsWithNewline = text.length > 0 && text.endsWith("\n");
  const count = text.length === 0 ? 0 : endsWithNewline ? starts.length - 1 : starts.length;
  return { starts, count };
}

/** One-based line containing `offset` (an offset at a line start belongs to that line). */
export function lineAt(index: LineIndex, offset: number): number {
  let low = 0;
  let high = index.starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (index.starts[mid]! <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low + 1;
}

/** Line numbers spanned by `[start, end)`; an empty span still occupies the line at `start`. */
export function lineSpan(index: LineIndex, start: number, end: number): [number, number] {
  const first = lineAt(index, start);
  const last = end > start ? lineAt(index, end - 1) : first;
  return [first, last];
}

/** Split a text into lines without their `\n`, matching `indexLines(text).count`. */
export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

/**
 * Line-level hunks for two texts, shaped like `git diff -U0` ranges, for files mode.
 * Uses the same "count 0 means after this line" convention as git headers.
 */
export function lineHunks(oldText: string, newText: string): HunkRange[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const { pairs } = myersDiff(oldLines, newLines, { maxCost: Number.MAX_SAFE_INTEGER });
  const hunks: HunkRange[] = [];

  let i = 0;
  let j = 0;
  for (const [pairI, pairJ] of [...pairs, [oldLines.length, newLines.length] as [number, number]]) {
    if (pairI > i || pairJ > j) {
      const oldCount = pairI - i;
      const newCount = pairJ - j;
      const oldStart = oldCount === 0 ? i : i + 1;
      const newStart = newCount === 0 ? j : j + 1;
      hunks.push({ oldStart, oldCount, newStart, newCount, header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` });
    }

    i = pairI + 1;
    j = pairJ + 1;
  }

  return hunks;
}
