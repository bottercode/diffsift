/**
 * Browser entry point: the same analysis with no Node built-ins. Callers provide the grammar
 * WASM files (as URLs or bytes) and file pairs they already have, for example a diff viewer that
 * holds both versions of each file. Bundlers can import the grammars from `diffsift/wasm/*`.
 */

import type { Grammar } from "./languages";
import { createParserHost, type ParserHost } from "./parser";
import { sift, type SiftOptions } from "./sift";
import type { FilePair, SiftResult } from "./types";

export type * from "./types";

export interface SifterOptions {
  /** URL of web-tree-sitter's `tree-sitter.wasm`. */
  treeSitterWasm?: string | URL;
  /** Each grammar as a URL to fetch or as bytes. */
  grammars: Record<Grammar, string | URL | Uint8Array>;
}

export interface Sifter {
  sift(pairs: readonly FilePair[], options?: SiftOptions): Promise<SiftResult>;
}

/** Load the grammars and return a reusable sifter. */
export async function createSifter(options: SifterOptions): Promise<Sifter> {
  const load = async (source: string | URL | Uint8Array) => (source instanceof Uint8Array ? source : new Uint8Array(await (await fetch(source)).arrayBuffer()));
  const [typescript, tsx, javascript] = await Promise.all([load(options.grammars.typescript), load(options.grammars.tsx), load(options.grammars.javascript)]);
  const host: ParserHost = await createParserHost({ grammars: { typescript, tsx, javascript }, treeSitterWasm: options.treeSitterWasm });

  return {
    sift: (pairs, siftOptions) => sift(pairs, host, { source: { kind: "files", diffAlgorithm: "myers" }, ...siftOptions }),
  };
}
