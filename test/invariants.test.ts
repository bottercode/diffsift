/**
 * Properties that must hold for every fixture, independent of its expected output:
 * determinism under input reordering, and that a file reported as purely formatting really has
 * identical code tokens on both sides. Also keeps shipped code free of Bun-only APIs.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sift } from "../src/sift";
import { grammarFor } from "../src/languages";
import { tokenize } from "../src/tokens";
import { createTestFixturePairs, testParserHost } from "./helpers";

const fixtures = join(import.meta.dir, "fixtures");
const cases = readdirSync(fixtures, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("invariants", () => {
  test("output does not depend on the order of file pairs", async () => {
    const host = await testParserHost();
    for (const name of cases) {
      const pairs = createTestFixturePairs(join(fixtures, name));
      const forward = JSON.stringify(await sift(pairs, host));
      const backward = JSON.stringify(await sift([...pairs].reverse(), host));
      expect(backward).toBe(forward);
    }
  });

  test("files reported as formatting-only have identical code tokens", async () => {
    const host = await testParserHost();
    let checked = 0;
    for (const name of cases) {
      const pairs = createTestFixturePairs(join(fixtures, name));
      const result = await sift(pairs, host);
      for (const file of result.files) {
        if (!file.analyzed || file.lines.some((entry) => entry.category !== "format" && entry.category !== "comment")) continue;
        const pair = pairs.find((candidate) => candidate.oldPath === file.oldPath && candidate.newPath === file.newPath)!;
        const grammar = grammarFor(pair.newPath ?? pair.oldPath ?? "")!;
        const codeKeys = (text: string) => {
          const parsed = host.parse(grammar, text);
          try {
            return tokenize(parsed.tree, text, grammar).tokens.filter((token) => token.kind !== "comment").map((token) => token.key);
          } finally {
            host.dispose(parsed);
          }
        };
        expect(codeKeys(pair.newText)).toEqual(codeKeys(pair.oldText));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("portability", () => {
  const root = join(import.meta.dir, "../src");
  const sources = (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => ({ path: relative(root, join(root, path)), text: readFileSync(join(root, path), "utf8") }));

  test("shipped code never uses Bun-only APIs, so it runs on Node", () => {
    for (const { path, text } of sources) {
      expect({ path, usesBun: /\bBun\.[A-Za-z]|from "bun:|import\.meta\.dir\b/.test(text) }).toEqual({ path, usesBun: false });
    }
  });

  test("the analysis core imports no Node built-ins, so it runs in browsers", () => {
    const nodeOnly = new Set(["cli.ts", "mcp.ts", "index.ts"]);
    for (const { path, text } of sources) {
      if (nodeOnly.has(path) || path.startsWith("node/")) continue;
      expect({ path, importsNode: /from "node:/.test(text) }).toEqual({ path, importsNode: false });
    }
  });
});
