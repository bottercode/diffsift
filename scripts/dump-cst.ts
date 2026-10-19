/**
 * Prints the leaves of a file's tree-sitter syntax tree with their parent chain, so tokenizer
 * rules can be checked against the real grammar shape. Usage: `bun scripts/dump-cst.ts <file> [snippet]`.
 */

import { readFileSync } from "node:fs";
import { Language, Parser, type Node } from "web-tree-sitter";

const [path, inline] = process.argv.slice(2);
if (!path) {
  console.error("usage: bun scripts/dump-cst.ts <file.ts|file.tsx|file.js> [source to parse instead]");
  process.exit(2);
}

const grammar = path.endsWith(".tsx") ? "tsx" : /\.[cm]?[jt]sx?$/.test(path) && /\.[cm]?jsx?$/.test(path) ? "javascript" : "typescript";
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(readFileSync(new URL(`../wasm/tree-sitter-${grammar}.wasm`, import.meta.url))));

const source = inline ?? readFileSync(path, "utf8");
const tree = parser.parse(source)!;
console.log(`grammar=${grammar} hasError=${tree.rootNode.hasError}`);

/** Walk depth-first and print each leaf with its ancestors' types. */
function visit(node: Node, ancestors: string[]) {
  if (node.childCount === 0) {
    const text = JSON.stringify(source.slice(node.startIndex, node.endIndex));
    console.log(`${String(node.startPosition.row + 1).padStart(3)}:${String(node.startPosition.column).padEnd(3)} ${node.type.padEnd(22)} ${text.padEnd(28)} ${ancestors.slice(-3).join(" > ")}${node.isMissing ? " MISSING" : ""}`);
    return;
  }

  for (const child of node.children) {
    if (child) visit(child, [...ancestors, node.type]);
  }
}

visit(tree.rootNode, []);
