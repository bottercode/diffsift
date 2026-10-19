/**
 * Loads each vendored grammar with the pinned web-tree-sitter and parses modern syntax, so a
 * grammar/runtime ABI mismatch shows up before anything is built on top of it. Plain ESM so the
 * same file runs under `bun` and `node`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Language, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION, Parser } from "web-tree-sitter";

const samples = {
  typescript: [
    "const config = { port: 3000 } satisfies Config;",
    "await using handle = open();",
    "class A { @logged accessor count = 0; }",
    'import data from "./data.json" with { type: "json" };',
    "function first<const T extends readonly unknown[]>(items: T) { return items[0]; }",
    "type Shape =\n  | { kind: 'circle' }\n  | { kind: 'square' };",
  ],
  tsx: ["const List = <T,>(props: { items: T[] }) => <ul>{props.items.map((i) => <li>{String(i)}</li>)}</ul>;"],
  javascript: ["const el = <div className='x'>hi {name}</div>;", "class A { #secret = 1; static { init(); } }"],
};

await Parser.init();
const runtime = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`;
console.log(`${runtime}  web-tree-sitter LANGUAGE_VERSION=${LANGUAGE_VERSION} MIN_COMPATIBLE_VERSION=${MIN_COMPATIBLE_VERSION}`);

let failures = 0;
for (const [name, sources] of Object.entries(samples)) {
  const path = fileURLToPath(new URL(`../wasm/tree-sitter-${name}.wasm`, import.meta.url));
  const language = await Language.load(readFileSync(path));
  const parser = new Parser();
  parser.setLanguage(language);

  for (const source of sources) {
    const tree = parser.parse(source);
    const ok = tree && !tree.rootNode.hasError;
    if (!ok) failures += 1;
    console.log(`  ${name.padEnd(10)} abi=${language.abiVersion} ${ok ? "ok   " : "ERROR"} ${source.split("\n")[0]}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
