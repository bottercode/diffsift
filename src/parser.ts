/**
 * Owns the web-tree-sitter runtime: initializes it once, loads the three grammars, and parses
 * text into trees. Runtime-neutral: callers hand in grammar bytes (Node reads them from disk,
 * browsers fetch them), so nothing here touches the filesystem.
 *
 * Trees live in WASM memory, so every `ParsedFile` must be released with `dispose()`.
 */

import { Language, Parser, type Tree } from "web-tree-sitter";
import { GRAMMARS, type Grammar } from "./languages";

export interface GrammarSources {
  /** Bytes for each grammar's `.wasm`. */
  grammars: Record<Grammar, Uint8Array>;
  /** Where to find web-tree-sitter's own `tree-sitter.wasm`; defaults to its package location. */
  treeSitterWasm?: string | URL;
}

export interface ParsedFile {
  grammar: Grammar;
  text: string;
  tree: Tree;
  /** `false` when tree-sitter recovered from syntax errors; such files are never analyzed. */
  ok: boolean;
}

export interface ParserHost {
  parse(grammar: Grammar, text: string): ParsedFile;
  dispose(parsed: ParsedFile): void;
}

let runtimeReady: Promise<void> | null = null;

/** Start web-tree-sitter at most once per process. */
function initRuntime(wasm: string | URL | undefined) {
  runtimeReady ??= Parser.init(wasm === undefined ? undefined : { locateFile: () => String(wasm) });
  return runtimeReady;
}

/** Load the grammars and return a parser host. */
export async function createParserHost(sources: GrammarSources): Promise<ParserHost> {
  await initRuntime(sources.treeSitterWasm);

  const parsers = new Map<Grammar, Parser>();
  for (const grammar of GRAMMARS) {
    const parser = new Parser();
    parser.setLanguage(await Language.load(sources.grammars[grammar]));
    parsers.set(grammar, parser);
  }

  return {
    parse(grammar, text) {
      const tree = parsers.get(grammar)!.parse(text);
      if (!tree) {
        throw new Error(`tree-sitter returned no tree for a ${grammar} file`);
      }

      return { grammar, text, tree, ok: !tree.rootNode.hasError };
    },

    dispose(parsed) {
      parsed.tree.delete();
    },
  };
}
