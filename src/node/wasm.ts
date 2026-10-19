/**
 * Reads the vendored grammar WASM files for Node and Bun. During development this module sits
 * in `src/node/`; in the package it is bundled into a file directly under `dist/`. Both are
 * siblings of the package's `wasm/` directory at different depths, so both locations are tried.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Grammar } from "../languages";
import type { GrammarSources } from "../parser";

// `dist/` first: from the package build, `../../wasm/` would point outside the package.
const CANDIDATE_DIRECTORIES = ["../wasm/", "../../wasm/"];

/** Absolute path of a vendored grammar file. */
export function grammarPath(grammar: Grammar): string {
  for (const directory of CANDIDATE_DIRECTORIES) {
    const path = fileURLToPath(new URL(`${directory}tree-sitter-${grammar}.wasm`, import.meta.url));
    if (existsSync(path)) return path;
  }

  throw new Error(`diffsift: cannot find tree-sitter-${grammar}.wasm next to ${fileURLToPath(import.meta.url)}`);
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
