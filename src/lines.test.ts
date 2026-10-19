import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexLines, lineAt, lineHunks, lineSpan, splitLines } from "./lines";
import { parsePatchFiles } from "./patch";

describe("line index", () => {
  test("counts lines like git, ignoring a trailing newline", () => {
    expect(indexLines("").count).toBe(0);
    expect(indexLines("a").count).toBe(1);
    expect(indexLines("a\n").count).toBe(1);
    expect(indexLines("a\nb").count).toBe(2);
    expect(splitLines("a\r\nb\n")).toEqual(["a\r", "b"]);
  });

  test("maps offsets to one-based lines", () => {
    const text = "ab\ncd\n\nef";
    const index = indexLines(text);
    expect(lineAt(index, 0)).toBe(1);
    expect(lineAt(index, 2)).toBe(1);
    expect(lineAt(index, 3)).toBe(2);
    expect(lineAt(index, 6)).toBe(3);
    expect(lineAt(index, 7)).toBe(4);
    expect(lineSpan(index, 1, 5)).toEqual([1, 2]);
    expect(lineSpan(index, 3, 3)).toEqual([2, 2]);
  });
});

describe("lineHunks", () => {
  test("matches git diff -U0 ranges on a mixed edit", () => {
    const oldText = "a\nb\nc\nd\ne\n";
    const newText = "a\nB\nc\nd\nx\ny\ne\nz\n";
    const directory = mkdtempSync(join(tmpdir(), "diffsift-lines-"));
    try {
      writeFileSync(join(directory, "old"), oldText);
      writeFileSync(join(directory, "new"), newText);
      const git = Bun.spawnSync(["git", "diff", "--no-index", "-U0", "--diff-algorithm=myers", "old", "new"], { cwd: directory });
      const fromGit = parsePatchFiles(git.stdout.toString())[0]!.hunks.map(({ header: _, ...range }) => range);
      const ours = lineHunks(oldText, newText).map(({ header: _, ...range }) => range);
      expect(ours).toEqual(fromGit);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("handles added and deleted files", () => {
    expect(lineHunks("", "a\nb\n").map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount])).toEqual([[0, 0, 1, 2]]);
    expect(lineHunks("a\n", "").map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount])).toEqual([[1, 1, 0, 0]]);
  });
});
