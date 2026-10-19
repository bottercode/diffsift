/**
 * Installs the packed npm tarball into a temporary project and runs it under plain Node: the
 * `diffsift` bin, the ESM library entry, and the browser entry with grammar bytes. Opt in with
 * `bun run build && DIFFSIFT_RUN_NODE_SMOKE=1 bun test test/node.smoke.test.ts`; it needs `node`,
 * `npm`, and registry access for the runtime dependencies.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRepo } from "./helpers";

const smoke = process.env.DIFFSIFT_RUN_NODE_SMOKE === "1" ? describe : describe.skip;
const packageRoot = join(import.meta.dir, "..");

/** Run a command and fail with its output when it exits non-zero. */
function runTestCommand(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} exited ${result.exitCode}\n${stdout}\n${result.stderr.toString()}`);
  return stdout;
}

smoke("packed package under Node", () => {
  let project: string;
  let repo: ReturnType<typeof createTestRepo>;

  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "diffsift-node-")));
    runTestCommand(["npm", "pack", "--ignore-scripts", "--pack-destination", project], packageRoot);
    const tarball = readdirSync(project).find((name) => name.endsWith(".tgz"))!;
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
    runTestCommand(["npm", "install", "--no-audit", "--no-fund", `./${tarball}`], project);
    repo = createTestRepo(join(import.meta.dir, "fixtures/golden-agent-refactor"));
  }, 120_000);

  afterAll(() => {
    repo?.cleanup();
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("the bin finds its grammars and prints JSON", () => {
    const stdout = runTestCommand(["node", join(project, "node_modules/.bin/diffsift"), "base..HEAD", "--json", "--repo", repo.root], project);
    const result = JSON.parse(stdout);
    expect(result.summary.realLines).toBe(1);
    expect(result.renames[0]).toMatchObject({ from: "getUser", to: "fetchUser" });
  });

  test("the library entry imports as ESM", () => {
    const script = `import { siftRevision } from "diffsift"; const r = await siftRevision(${JSON.stringify(repo.root)}, "base..HEAD"); console.log(r.moves[0].symbol, r.moves[0].changedInside);`;
    expect(runTestCommand(["node", "--input-type=module", "-e", script], project).trim()).toBe("isExpired true");
  });

  test("the browser entry analyzes pairs from grammar bytes", () => {
    const script = [
      `import { readFile } from "node:fs/promises";`,
      `import { createSifter } from "diffsift/browser";`,
      `const wasm = (name) => readFile(new URL(import.meta.resolve("diffsift/wasm/tree-sitter-" + name + ".wasm")));`,
      `const sifter = await createSifter({ grammars: { typescript: await wasm("typescript"), tsx: await wasm("tsx"), javascript: await wasm("javascript") } });`,
      `const r = await sifter.sift([{ oldPath: "a.ts", newPath: "a.ts", oldText: "const a = 'x'\\n", newText: 'const a = "x";\\n', status: "modified" }]);`,
      `console.log(r.summary.realLines, r.formatFiles[0].formatOnly);`,
    ].join("\n");
    expect(runTestCommand(["node", "--input-type=module", "-e", script], project).trim()).toBe("0 true");
  });

  test("the schema is exported", () => {
    const script = `import schema from "diffsift/schema.json" with { type: "json" }; console.log(schema.properties.schemaVersion.const);`;
    expect(runTestCommand(["node", "--input-type=module", "-e", script], project).trim()).toBe("1");
  });
});
