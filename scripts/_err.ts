import { readFileSync } from "node:fs";
import { Language, Parser, type Node } from "web-tree-sitter";
await Parser.init();
const p = new Parser();
const file = process.argv[2]!;
p.setLanguage(await Language.load(readFileSync(`wasm/tree-sitter-${file.endsWith(".tsx") ? "tsx" : "typescript"}.wasm`)));
const src = readFileSync(file, "utf8");
const t = p.parse(src)!;
const errs: Node[] = [];
const walk = (n: Node) => { if (n.type === "ERROR" || n.isMissing) { errs.push(n); return; } for (const c of n.children) if (c && c.hasError) walk(c); else if (c && (c.isMissing)) errs.push(c); };
walk(t.rootNode);
for (const e of errs.slice(0, 5)) { const line = e.startPosition.row; console.log(`${e.isMissing ? "MISSING " + e.type : "ERROR"} at ${line + 1}:${e.startPosition.column}`); console.log(src.split("\n").slice(Math.max(0, line - 1), line + 2).map((l, i) => `  ${line + i}: ${l}`).join("\n")); }
