/**
 * Checks that the test suite guards every safety rule. For each rule it disables the rule in the
 * source with an exact text replacement, runs `bun test`, and expects at least one failure; a
 * passing suite means that rule could break unnoticed. Sources are restored after every run, and
 * a replacement whose text no longer exists fails loudly so this list stays in step with the code.
 *
 * Usage: `bun run mutate` (or `bun scripts/mutate.ts <label>` to run one).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Sabotage {
  label: string;
  file: string;
  find: string;
  replace: string;
  /** Defense in depth: other checks already reject every case found so far, so no test can fail. */
  coveredBy?: string;
}

const root = join(import.meta.dir, "..");

const SABOTAGES: Sabotage[] = [
  {
    label: "files with parse errors are analyzed",
    file: "src/parser.ts",
    find: "ok: !tree.rootNode.hasError",
    replace: "ok: true",
  },
  {
    label: "statements get no end token (ASI hazards look like formatting)",
    file: "src/tokens.ts",
    find: 'if (STATEMENTS.has(type) || (type === "export_statement" && node.childForFieldName("declaration") === null)) {\n      push("end", "", type, node.endIndex, node.endIndex);\n    } else if',
    replace: "if",
  },
  {
    label: "every comma is a droppable trailing comma (array holes vanish)",
    file: "src/tokens.ts",
    find: 'if (type === "," && parent && isTrailingComma(node)) {',
    replace: 'if (type === "," && parent) {',
  },
  {
    label: "parentheses are dropped everywhere",
    file: "src/tokens.ts",
    find: "(isTransparentParens(parent) || isSingleArrowParam(parent))",
    replace: "true",
  },
  {
    label: "directive comments are treated as plain comments",
    file: "src/tokens.ts",
    find: "if (isDirectiveComment(raw, grammar)) {",
    replace: "if (false) {",
  },
  {
    label: "renames may capture or keep the old name",
    file: "src/renames.ts",
    find: "if ((newNames.get(from) ?? []).length > 0 || (oldNames.get(to) ?? []).length > 0) continue;",
    replace: "",
  },
  {
    label: "partial renames are accepted",
    file: "src/renames.ts",
    find: "if (oldOccurrences.some((index) => !alignedOld.has(index))) continue;",
    replace: "",
  },
  {
    label: "renamed shorthand properties are accepted",
    file: "src/renames.ts",
    find: "if (shorthand(oldTokens, oldOccurrences) || shorthand(newTokens, newOccurrences)) continue;",
    replace: "",
  },
  {
    label: "names used as strings may be renamed",
    file: "src/renames.ts",
    find: "if (oldStrings.has(from)) continue;",
    replace: "",
  },
  {
    label: "renames need not be anchored at their declaration",
    file: "src/renames.ts",
    find: "if (!pairs.some(([i, j]) => i === oldBindings[0] && j === newBindings[0])) continue;",
    replace: "",
    coveredBy: "structural token keys keep declarations from aligning with uses, and the completeness check rejects the rest",
  },
  {
    label: "references outside the binding's scope are ignored",
    file: "src/renames.ts",
    find: "if (!oldOccurrences.every((index) => isWithin(oldTokens[index]!.node!, binding.scope))) continue;",
    replace: "",
  },
  {
    label: "unchanged files that still use the old name are ignored",
    file: "src/renames.ts",
    find: "if (stale.length > 0) continue;",
    replace: "",
  },
  {
    label: "order-sensitive declarations may move between files",
    file: "src/match.ts",
    find: "if (!source.decl.orderInsensitive || !target.decl.orderInsensitive) continue;",
    replace: "",
  },
  {
    label: "ambiguous same-name declarations are paired as moves",
    file: "src/match.ts",
    find: "if (sources.length !== 1 || targets.length !== 1) continue;",
    replace: "if (sources.length === 0 || targets.length === 0) continue;",
  },
];

const only = process.argv[2];
const selected = only ? SABOTAGES.filter((sabotage) => sabotage.label.includes(only)) : SABOTAGES;
const survivors: string[] = [];

for (const sabotage of selected) {
  const path = join(root, sabotage.file);
  const original = readFileSync(path, "utf8");
  const count = original.split(sabotage.find).length - 1;
  if (count !== 1) throw new Error(`${sabotage.label}: expected the target text once in ${sabotage.file}, found ${count}`);

  writeFileSync(path, original.replace(sabotage.find, sabotage.replace));
  try {
    const run = Bun.spawnSync(["bun", "test"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, DIFFSIFT_RUN_NODE_SMOKE: "" } });
    const output = run.stderr.toString();
    const failed = /(\d+) fail/.exec(output)?.[1] ?? "?";
    const caught = run.exitCode !== 0;
    if (caught) console.log(`caught    ${sabotage.label} (${failed} failing)`);
    else if (sabotage.coveredBy) console.log(`covered   ${sabotage.label}: ${sabotage.coveredBy}`);
    else console.log(`SURVIVED  ${sabotage.label}`);
    if (!caught && !sabotage.coveredBy) survivors.push(sabotage.label);
  } finally {
    writeFileSync(path, original);
  }
}

if (survivors.length > 0) {
  console.error(`\n${survivors.length} sabotage(s) survived the test suite; add a test for each.`);
  process.exitCode = 1;
}
