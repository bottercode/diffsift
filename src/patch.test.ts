import { describe, expect, test } from "bun:test";
import { newLinesOf, oldLinesOf, parseHunkHeader, parsePatchFiles } from "./patch";

describe("parseHunkHeader", () => {
  test("reads counts and defaults omitted counts to 1", () => {
    expect(parseHunkHeader("@@ -3,2 +4 @@ fn()")).toMatchObject({ oldStart: 3, oldCount: 2, newStart: 4, newCount: 1 });
    expect(parseHunkHeader("@@ -0,0 +1,5 @@")).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 5 });
    expect(parseHunkHeader("+not a header")).toBeNull();
  });

  test("lists the changed lines on each side", () => {
    const hunk = parseHunkHeader("@@ -10,3 +10,0 @@")!;
    expect(oldLinesOf(hunk)).toEqual([10, 11, 12]);
    expect(newLinesOf(hunk)).toEqual([]);
  });
});

describe("parsePatchFiles", () => {
  test("splits files in order and keeps binary and hunkless entries", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "@@ -5,0 +6,2 @@",
      "+x",
      "+y",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");

    const files = parsePatchFiles(patch);
    expect(files).toHaveLength(3);
    expect(files[0]!.hunks.map((hunk) => [hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount])).toEqual([
      [1, 1, 1, 1],
      [5, 0, 6, 2],
    ]);
    expect(files[1]).toEqual({ hunks: [], binary: true });
    expect(files[2]).toEqual({ hunks: [], binary: false });
  });

  test("does not mistake an added line that looks like a header for a hunk", () => {
    const patch = ["diff --git a/a.ts b/a.ts", "@@ -1,0 +1,1 @@", "+@@ -9 +9 @@ not real", ""].join("\n");
    expect(parsePatchFiles(patch)[0]!.hunks).toHaveLength(1);
  });
});
