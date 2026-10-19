/**
 * Builds the npm package: bundles the Node entry, the browser entry, and the CLI into `dist/`
 * as ESM for Node 22+, keeping runtime dependencies external, then emits type declarations.
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/browser.ts", "src/cli.ts"].map((entry) => join(root, entry)),
  outdir: dist,
  target: "node",
  format: "esm",
  splitting: true,
  external: ["web-tree-sitter", "@modelcontextprotocol/sdk", "zod"],
  naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The bin needs a Node shebang even when the bundler drops the source's.
const cli = join(dist, "cli.js");
const text = readFileSync(cli, "utf8").replace(/^#!.*\n/, "");
writeFileSync(cli, `#!/usr/bin/env node\n${text}`);
chmodSync(cli, 0o755);

const types = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (types.exitCode !== 0) process.exit(types.exitCode ?? 1);

console.log(result.outputs.map((output) => output.path.replace(`${root}/`, "")).join("\n"));
