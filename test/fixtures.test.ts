/**
 * Runs every case in `test/fixtures/<case>/{old,new}/` through diffsift in files mode and compares
 * a stable projection of the result with `expected.json`. `UPDATE_FIXTURES=1 bun test` rewrites
 * the expected files locally after a deliberate behavior change; review the diff before committing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFixturePairs, projectTestResult, testParserHost } from "./helpers";
import { sift } from "../src/sift";

const root = join(import.meta.dir, "fixtures");
const cases = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("fixtures", () => {
  for (const name of cases) {
    test(name, async () => {
      const directory = join(root, name);
      const result = await sift(createTestFixturePairs(directory), await testParserHost(), { source: { kind: "files", diffAlgorithm: "myers" } });
      const projection = projectTestResult(result);
      const expectedPath = join(directory, "expected.json");

      if (process.env.UPDATE_FIXTURES === "1" || !existsSync(expectedPath)) {
        writeFileSync(expectedPath, `${JSON.stringify(projection, null, 2)}\n`);
        if (process.env.UPDATE_FIXTURES !== "1") throw new Error(`${name}: wrote a new expected.json; review it, then rerun`);
        return;
      }

      expect(projection).toEqual(JSON.parse(readFileSync(expectedPath, "utf8")));
    });
  }
});
