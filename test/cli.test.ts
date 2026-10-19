/**
 * Black-box checks of the `diffsift` command: text output, JSON output, exit codes, and color
 * handling, run against a temporary repository built from the golden fixture.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRepo } from "./helpers";

const cli = join(import.meta.dir, "../src/cli.ts");
const golden = join(import.meta.dir, "fixtures/golden-agent-refactor");
let repo: ReturnType<typeof createTestRepo>;

beforeAll(() => {
  repo = createTestRepo(golden);
});

afterAll(() => repo.cleanup());

/** Run the CLI in the test repo. */
function run(args: string[], env: Record<string, string> = {}) {
  const { NO_COLOR: _noColor, FORCE_COLOR: _forceColor, ...inherited } = process.env;
  const result = Bun.spawnSync([process.execPath, cli, ...args], { cwd: repo.root, env: { ...inherited, ...env } });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("diffsift CLI", () => {
  test("prints the golden summary", () => {
    const { code, stdout } = run(["base..HEAD", "--no-color"]);
    expect(code).toBe(0);
    expect(stdout).toBe(
      [
        "diffsift base..HEAD · 3 files · 20 changed lines · 18 mechanical (90%)",
        "  ✓ rename  getUser → fetchUser   3 places in 2 files, exported",
        "  ⚠ move    isExpired  src/utils.ts → src/auth/session.ts   changed while moving",
        "            - src/utils.ts:6  return session.expiresAt < Date.now()",
        "            + src/auth/session.ts:2  return session.expiresAt <= Date.now();",
        "  ✓ format  8 lines in src/api.ts, src/utils.ts   quotes, semicolons, whitespace",
        "",
        "Real changes: 1 line",
        "  src/auth/session.ts:2  in isExpired",
        "    + return session.expiresAt <= Date.now();",
        "",
      ].join("\n"),
    );
  });

  test("--json prints schema v1", () => {
    const { stdout } = run(["base..HEAD", "--json"]);
    const result = JSON.parse(stdout);
    expect(result.schemaVersion).toBe(1);
    expect(result.summary.realLines).toBe(1);
  });

  test("--only real keeps only real line entries", () => {
    const result = JSON.parse(run(["base..HEAD", "--json", "--only", "real"]).stdout);
    const categories = new Set(result.files.flatMap((file: { lines: Array<{ category: string }> }) => file.lines.map((line) => line.category)));
    expect([...categories]).toEqual(["real"]);
  });

  test("--exit-code exits 1 when there are real changes", () => {
    expect(run(["base..HEAD", "--exit-code", "--no-color"]).code).toBe(1);
    expect(run(["HEAD..HEAD", "--exit-code", "--no-color"]).code).toBe(0);
  });

  test("colors only when asked or on a TTY", () => {
    expect(run(["base..HEAD"]).stdout).not.toContain("\u001b[");
    expect(run(["base..HEAD"], { FORCE_COLOR: "1" }).stdout).toContain("\u001b[");
    expect(run(["base..HEAD", "--color"], { NO_COLOR: "1" }).stdout).toContain("\u001b[");
  });

  test("reports errors with exit code 2", () => {
    const { code, stderr } = run(["--only", "nope"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--only must be one of");
  });
});
