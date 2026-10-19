/**
 * Reads the vendored grammar WASM files for Node and Bun. The `../../wasm/` path resolves from
 * `src/node/` during development; the build copies this module to `dist/node/` so the same
 * relative path reaches the packaged `wasm/` directory.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Grammar } from "../languages";
import type { GrammarSources } from "../parser";

/** Absolute path of a vendored grammar file. */
export function grammarPath(grammar: Grammar): string {
  return fileURLToPath(new URL(`../../wasm/tree-sitter-${grammar}.wasm`, import.meta.url));
}

/** Read all three grammars from disk. */
export async function readGrammarSources(): Promise<GrammarSources> {
  const [typescript, tsx, javascript] = await Promise.all([
    readFile(grammarPath("typescript")),
    readFile(grammarPath("tsx")),
    readFile(grammarPath("javascript")),
  ]);

  return { grammars: { typescript, tsx, javascript } };
}
