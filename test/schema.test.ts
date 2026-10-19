/**
 * Validates the full result of every fixture, plus a git-mode run, against the published JSON
 * Schema, so the schema file and the `SiftResult` type cannot drift apart unnoticed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { siftRevision } from "../src/index";
import { sift } from "../src/sift";
import { createTestFixturePairs, createTestRepo, testParserHost } from "./helpers";

const fixtures = join(import.meta.dir, "fixtures");
const schema = JSON.parse(readFileSync(join(import.meta.dir, "../schema/diffsift.schema.v1.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Assert a result matches the schema, printing ajv's errors on failure. */
function expectTestSchemaValid(name: string, result: unknown) {
  const valid = validate(result);
  expect({ name, errors: valid ? null : validate.errors }).toEqual({ name, errors: null });
}

describe("schema v1", () => {
  test("every fixture result validates", async () => {
    const host = await testParserHost();
    const cases = readdirSync(fixtures, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of cases) {
      expectTestSchemaValid(entry.name, await sift(createTestFixturePairs(join(fixtures, entry.name)), host));
    }
  });

  test("a git-mode result validates", async () => {
    const repo = createTestRepo(join(fixtures, "golden-agent-refactor"));
    cleanups.push(repo.cleanup);
    expectTestSchemaValid("git", await siftRevision(repo.root, "base..HEAD"));
  });
});
