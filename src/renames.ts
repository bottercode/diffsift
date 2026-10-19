/**
 * Finds identifier renames that are provably consistent, so lines that only rename can be
 * labeled "rename" instead of real. A rename `a → b` is accepted only when all of these hold:
 *
 * - **Anchored:** `a` is declared exactly once in the old file, `b` exactly once in the new file,
 *   and the two declarations line up. Renaming an import from a package outside the change set is
 *   therefore real: it now refers to something else.
 * - **Complete:** every old occurrence of `a` lines up with `b`, `a` no longer appears in the new
 *   file, and `b` did not appear in the old file (so nothing was captured or shadowed).
 * - **Scoped:** every occurrence of a local `a` sits inside the scope that declares it.
 * - **Not observable by name:** `a`/`b` are not used as shorthand object keys and `a` is not used
 *   as a string; the file has no `eval` or `with`.
 * - **Linked across files:** renaming an exported name requires every importer in the change set
 *   to rename its import the same way, and (in git mode) no unchanged file may still mention `a`.
 *
 * Substitutions apply to specific old-side token occurrences, never to a name globally.
 */

import type { Node } from "web-tree-sitter";
import { buildGaps, type Substitutions } from "./classify";
import { resolveModule } from "./imports";
import { lineAt } from "./lines";
import { myersDiff } from "./myers";
import type { AnalyzedFile } from "./summary";
import type { Token } from "./tokens";
import type { Rename } from "./types";

export interface RenameGroup {
  /** Internal identity used in line evidence until ids are assigned. */
  ref: string;
  from: string;
  to: string;
  report: Omit<Rename, "id">;
}

export interface RenameResult {
  groups: RenameGroup[];
  substitutions: Map<AnalyzedFile, Substitutions>;
}

export interface RenameOptions {
  staleReferences?: (name: string) => Promise<string[]> | string[];
  filesMode?: boolean;
}

/** One file's candidate rename that passed the local checks. */
interface LocalRename {
  file: AnalyzedFile;
  from: string;
  to: string;
  /** Old-side token indices to substitute. */
  occurrences: number[];
  /** How the old name is introduced in this file. */
  binding: "declaration" | "import" | "imported-name";
  kind: string;
  scope: "module" | "local" | "type";
  exported: boolean;
  /** For imports: the file the import resolves to (old path), when it is in the change set. */
  source: string | null;
  /** New-side line of the declaration (or import) of the new name. */
  declaredLine: number;
}

const IDENTIFIER_TYPES = new Set(["identifier", "type_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]);
const SCOPE_TYPES = new Set(["statement_block", "program", "for_statement", "for_in_statement", "switch_body", "class_static_block"]);
const FUNCTION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "function",
  "generator_function",
  "arrow_function",
  "method_definition",
]);
const PATTERN_TYPES = new Set(["object_pattern", "array_pattern", "pair_pattern", "assignment_pattern", "rest_pattern"]);
const NAMED_DECLARATIONS = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "function_signature",
]);

/** Find accepted renames across all analyzed files. */
export async function findRenames(files: AnalyzedFile[], options: RenameOptions = {}): Promise<RenameResult> {
  const knownOldPaths = new Set(files.map((file) => file.oldPath).filter((path): path is string => path !== null));
  const locals: LocalRename[] = [];

  for (const file of files) {
    if (!file.analyzed || !file.oldPath || !file.newPath) continue;
    locals.push(...localRenames(file, knownOldPaths));
  }

  const groups: RenameGroup[] = [];
  const substitutions = new Map<AnalyzedFile, Substitutions>();
  const used = new Set<LocalRename>();

  for (const anchor of locals) {
    if (anchor.binding !== "declaration" || used.has(anchor)) continue;
    const members = [anchor];

    if (anchor.exported) {
      const importers = importersOf(files, anchor, knownOldPaths);
      if (importers === null) continue;
      let complete = true;
      for (const importer of importers) {
        const match = locals.find(
          (local) => local.file === importer && local.binding !== "declaration" && local.from === anchor.from && local.to === anchor.to && local.source === anchor.file.oldPath,
        );
        if (!match) {
          complete = false;
          break;
        }
        members.push(match);
      }
      if (!complete) continue;

      if (!options.filesMode && options.staleReferences) {
        const changed = new Set(files.flatMap((file) => [file.oldPath, file.newPath]).filter(Boolean));
        const stale = (await options.staleReferences(anchor.from)).filter((path) => !changed.has(path));
        if (stale.length > 0) continue;
      }
    }

    members.forEach((member) => used.add(member));
    const ref = `rename:${anchor.file.newPath}:${anchor.from}:${anchor.to}`;
    const occurrences = members.flatMap((member) =>
      member.occurrences.map((index) => ({ file: member.file.newPath ?? "", line: lineAt(member.file.old.lines, member.file.old.stream!.tokens[index]!.start) })),
    );

    for (const member of members) {
      let map = substitutions.get(member.file);
      if (!map) {
        map = new Map();
        substitutions.set(member.file, map);
      }
      for (const index of member.occurrences) {
        const token = member.file.old.stream!.tokens[index]!;
        map.set(index, { key: renameKey(token, member.to), ref });
      }
    }

    groups.push({
      ref,
      from: anchor.from,
      to: anchor.to,
      report: {
        from: anchor.from,
        to: anchor.to,
        kind: anchor.kind,
        scope: anchor.scope,
        exported: anchor.exported,
        count: members.reduce((total, member) => total + member.occurrences.length, 0),
        declaredIn: { file: anchor.file.newPath ?? "", line: anchor.declaredLine },
        occurrences: occurrences.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)),
        ...(options.filesMode && anchor.exported ? { crossFileUnverified: true } : {}),
      },
    });
  }

  groups.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return { groups, substitutions };
}

/** Old-side files in the change set that import `anchor.from` from the anchor's file; `null` if one cannot be checked. */
function importersOf(files: AnalyzedFile[], anchor: LocalRename, knownOldPaths: Set<string>): AnalyzedFile[] | null {
  const importers: AnalyzedFile[] = [];
  for (const file of files) {
    if (file === anchor.file || !file.oldPath) continue;
    const imports = file.analyzed ? importsOf(file, knownOldPaths) : null;
    if (imports === null) {
      // Unanalyzed files in the change set might import the name; refuse rather than guess.
      if (file.old.text.includes(anchor.from)) return null;
      continue;
    }
    if (imports.some((entry) => entry.source === anchor.file.oldPath && entry.imported === anchor.from)) {
      importers.push(file);
    }
  }

  return importers;
}

interface ImportEntry {
  source: string | null;
  imported: string;
  local: string;
}

/** Named imports on the old side of a file, with their resolved sources. */
function importsOf(file: AnalyzedFile, knownOldPaths: Set<string>): ImportEntry[] {
  const root = file.oldParsed!.tree.rootNode;
  const entries: ImportEntry[] = [];
  for (const statement of root.namedChildren) {
    if (statement?.type !== "import_statement") continue;
    const sourceNode = statement.childForFieldName("source");
    const specifier = sourceNode ? sourceNode.text.slice(1, -1) : "";
    const source = resolveModule(file.oldPath!, specifier, knownOldPaths);
    for (const node of statement.descendantsOfType("import_specifier")) {
      if (!node) continue;
      const name = node.childForFieldName("name")?.text;
      const alias = node.childForFieldName("alias")?.text;
      if (name) entries.push({ source, imported: name, local: alias ?? name });
    }
  }

  return entries;
}

/** Candidate renames in one file that pass every check that needs only this file. */
function localRenames(file: AnalyzedFile, knownOldPaths: Set<string>): LocalRename[] {
  const oldTokens = file.old.stream!.tokens;
  const newTokens = file.new.stream!.tokens;
  if (hasUnsafeScope(file.oldParsed!.tree.rootNode) || hasUnsafeScope(file.newParsed!.tree.rootNode)) {
    return [];
  }

  // Align identifiers inside each change gap with their names abstracted away, and collect the
  // old → new name pairs that line up.
  const aligned = new Map<string, Array<[number, number]>>();
  for (const gap of buildGaps(file.hunks, file.old, file.new)) {
    const oldCode = gap.old.filter((index) => oldTokens[index]!.kind !== "comment");
    const newCode = gap.new.filter((index) => newTokens[index]!.kind !== "comment");
    const { pairs } = myersDiff(
      oldCode.map((index) => abstractKey(oldTokens[index]!)),
      newCode.map((index) => abstractKey(newTokens[index]!)),
    );
    for (const [i, j] of pairs) {
      const oldToken = oldTokens[oldCode[i]!]!;
      const newToken = newTokens[newCode[j]!]!;
      if (!isRenamable(oldToken) || oldToken.raw === newToken.raw) continue;
      const key = `${oldToken.raw}\u0000${newToken.raw}`;
      const list = aligned.get(key) ?? [];
      list.push([oldCode[i]!, newCode[j]!]);
      aligned.set(key, list);
    }
  }

  const oldNames = identifierIndex(oldTokens);
  const newNames = identifierIndex(newTokens);
  const oldStrings = stringValues(oldTokens);
  const results: LocalRename[] = [];

  for (const [key, pairs] of aligned) {
    const [from, to] = key.split("\u0000") as [string, string];
    const oldOccurrences = oldNames.get(from) ?? [];
    const newOccurrences = newNames.get(to) ?? [];

    // Complete and capture-free: every old `a` lines up with a `b`, `a` is gone, `b` is new.
    if ((newNames.get(from) ?? []).length > 0 || (oldNames.get(to) ?? []).length > 0) continue;
    const alignedOld = new Set(pairs.map(([i]) => i));
    if (oldOccurrences.some((index) => !alignedOld.has(index))) continue;

    // Observable by name: shorthand keys and string uses.
    const shorthand = (tokens: Token[], indices: number[]) => indices.some((index) => tokens[index]!.node!.type.startsWith("shorthand_property"));
    if (shorthand(oldTokens, oldOccurrences) || shorthand(newTokens, newOccurrences)) continue;
    if (oldStrings.has(from)) continue;

    // Anchored: one declaration of each name, lined up with each other.
    const oldBindings = oldOccurrences.filter((index) => bindingOf(oldTokens[index]!.node!) !== null);
    const newBindings = newOccurrences.filter((index) => bindingOf(newTokens[index]!.node!) !== null);
    if (oldBindings.length !== 1 || newBindings.length !== 1) {
      const imported = importedNameRename(file, pairs, from, to, knownOldPaths);
      if (imported) results.push(imported);
      continue;
    }
    if (!pairs.some(([i, j]) => i === oldBindings[0] && j === newBindings[0])) continue;

    const binding = bindingOf(oldTokens[oldBindings[0]!]!.node!)!;
    if (!oldOccurrences.every((index) => isWithin(oldTokens[index]!.node!, binding.scope))) continue;

    const declaredLine = lineAt(file.new.lines, newTokens[newBindings[0]!]!.start);
    const isImport = binding.kind === "import";
    results.push({
      file,
      from,
      to,
      occurrences: [...oldOccurrences].sort((a, b) => a - b),
      binding: isImport ? "import" : "declaration",
      kind: binding.kind,
      scope: binding.scope.type === "program" ? (binding.typeOnly ? "type" : "module") : "local",
      exported: !isImport && binding.scope.type === "program" && isExported(oldTokens[oldBindings[0]!]!.node!, from),
      source: isImport ? importSource(oldTokens[oldBindings[0]!]!.node!, file.oldPath!, knownOldPaths) : null,
      declaredLine,
    });
  }

  return results;
}

/**
 * `import { a as x }` → `import { b as x }`: only the imported name changes; the local binding
 * `x` is untouched. Accepted (pending the source file's rename) when that is the only use of `a`.
 */
function importedNameRename(file: AnalyzedFile, pairs: Array<[number, number]>, from: string, to: string, knownOldPaths: Set<string>): LocalRename | null {
  if (pairs.length !== 1) return null;
  const [i, j] = pairs[0]!;
  const oldNode = file.old.stream!.tokens[i]!.node!;
  const newNode = file.new.stream!.tokens[j]!.node!;
  const oldSpecifier = oldNode.parent;
  if (oldSpecifier?.type !== "import_specifier" || !oldSpecifier.childForFieldName("name")?.equals(oldNode) || !oldSpecifier.childForFieldName("alias")) return null;
  if (newNode.parent?.type !== "import_specifier" || !newNode.parent.childForFieldName("alias")) return null;

  return {
    file,
    from,
    to,
    occurrences: [i],
    binding: "imported-name",
    kind: "import",
    scope: "module",
    exported: false,
    source: importSource(oldNode, file.oldPath!, knownOldPaths),
    declaredLine: lineAt(file.new.lines, file.new.stream!.tokens[j]!.start),
  };
}

/** The key a token would have under a new name. */
function renameKey(token: Token, to: string): string {
  const [kind, , parent] = token.key.split("\u0001");
  return `${kind}\u0001${to}\u0001${parent}`;
}

/** Comparison key with identifier names abstracted away, for alignment only. */
function abstractKey(token: Token): string {
  if (!isRenamable(token)) return token.key;
  const [kind, , parent] = token.key.split("\u0001");
  return `${kind}\u0001\u0004ID\u0001${parent}`;
}

/** Identifier-like tokens that can take part in a rename (not property names). */
function isRenamable(token: Token): boolean {
  return token.node !== undefined && IDENTIFIER_TYPES.has(token.node.type);
}

/** Token indices of each identifier name. */
function identifierIndex(tokens: Token[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  tokens.forEach((token, position) => {
    if (!isRenamable(token)) return;
    const list = index.get(token.raw) ?? [];
    list.push(position);
    index.set(token.raw, list);
  });

  return index;
}

/** Cooked string literal values in a file, for the reflection check. */
function stringValues(tokens: Token[]): Set<string> {
  const values = new Set<string>();
  for (const token of tokens) {
    const norm = token.key.split("\u0001")[1] ?? "";
    if (norm.startsWith("S:")) {
      try {
        values.add(JSON.parse(norm.slice(2)) as string);
      } catch {
        // Not a cooked string.
      }
    } else if (norm.startsWith("R:") || norm.startsWith("K:")) {
      values.add(norm.slice(2));
    } else if (token.raw && token.key.includes("\u0001template_string")) {
      values.add(token.raw);
    }
  }

  return values;
}

interface Binding {
  kind: string;
  scope: Node;
  typeOnly: boolean;
}

/** If `node` declares a name, what it declares and in which scope; otherwise `null`. */
function bindingOf(node: Node): Binding | null {
  const parent = node.parent;
  if (!parent) return null;

  if (NAMED_DECLARATIONS.has(parent.type) && parent.childForFieldName("name")?.equals(node)) {
    const typeOnly = parent.type === "interface_declaration" || parent.type === "type_alias_declaration";
    return { kind: declarationKind(parent.type), scope: nearestScope(parent), typeOnly };
  }

  if (parent.type === "import_specifier") {
    const alias = parent.childForFieldName("alias");
    const local = alias ?? parent.childForFieldName("name");
    return local?.equals(node) ? { kind: "import", scope: rootOf(node), typeOnly: false } : null;
  }

  if (parent.type === "import_clause" || parent.type === "namespace_import") {
    return { kind: "import", scope: rootOf(node), typeOnly: false };
  }

  if (parent.type === "type_parameter" && parent.childForFieldName("name")?.equals(node)) {
    return { kind: "type-parameter", scope: parent.parent?.parent ?? parent, typeOnly: true };
  }

  // Walk up through destructuring patterns to the construct that introduces the binding.
  let child: Node = node;
  let current: Node | null = parent;
  while (current && PATTERN_TYPES.has(current.type)) {
    if (current.type === "assignment_pattern" && !current.childForFieldName("left")?.equals(child)) return null;
    if (current.type === "pair_pattern" && !current.childForFieldName("value")?.equals(child)) return null;
    child = current;
    current = current.parent;
  }
  if (!current) return null;

  if (current.type === "variable_declarator" && current.childForFieldName("name")?.equals(child)) {
    const declaration = current.parent;
    const isVar = declaration?.type === "variable_declaration";
    const keyword = declaration?.firstChild?.text ?? "var";
    return { kind: keyword, scope: isVar ? nearestFunctionScope(current) : nearestScope(current), typeOnly: false };
  }

  if ((current.type === "required_parameter" || current.type === "optional_parameter") && current.childForFieldName("pattern")?.equals(child)) {
    const fn = current.parent?.parent;
    return fn ? { kind: "parameter", scope: fn, typeOnly: false } : null;
  }

  if (current.type === "arrow_function" && current.childForFieldName("parameter")?.equals(child)) {
    return { kind: "parameter", scope: current, typeOnly: false };
  }

  if (current.type === "catch_clause" && current.childForFieldName("parameter")?.equals(child)) {
    return { kind: "parameter", scope: current, typeOnly: false };
  }

  if (current.type === "for_in_statement" && current.childForFieldName("left")?.equals(child) && current.childForFieldName("kind")) {
    return { kind: "let", scope: current, typeOnly: false };
  }

  if ((current.type === "function_expression" || current.type === "function" || current.type === "class") && current.childForFieldName("name")?.equals(child)) {
    return { kind: current.type === "class" ? "class" : "function", scope: current, typeOnly: false };
  }

  return null;
}

/** Report kind for a named declaration node. */
function declarationKind(type: string): string {
  if (type.includes("function")) return "function";
  if (type.includes("class")) return "class";
  if (type === "interface_declaration") return "interface";
  if (type === "type_alias_declaration") return "type";
  return "enum";
}

/** Nearest block-like ancestor (where `let`, `const`, and declarations are scoped). */
function nearestScope(node: Node): Node {
  let current = node.parent;
  while (current) {
    if (SCOPE_TYPES.has(current.type) || FUNCTION_TYPES.has(current.type)) return current;
    current = current.parent;
  }

  return rootOf(node);
}

/** Nearest function or program (where `var` is scoped). */
function nearestFunctionScope(node: Node): Node {
  let current = node.parent;
  while (current) {
    if (FUNCTION_TYPES.has(current.type) || current.type === "program") return current;
    current = current.parent;
  }

  return rootOf(node);
}

/** Root `program` node of a tree. */
function rootOf(node: Node): Node {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

/** True when `node` is `scope` or inside it. */
function isWithin(node: Node, scope: Node): boolean {
  return node.startIndex >= scope.startIndex && node.endIndex <= scope.endIndex;
}

/** True for module-level declarations that are exported directly or through `export { name }`. */
function isExported(nameNode: Node, name: string): boolean {
  const declaration = nameNode.parent;
  if (declaration?.parent?.type === "export_statement") return true;
  if (declaration?.parent?.parent?.type === "export_statement") return true;

  const root = rootOf(nameNode);
  for (const specifier of root.descendantsOfType("export_specifier")) {
    if (specifier?.childForFieldName("name")?.text === name) return true;
  }

  return false;
}

/** Old path of the module an import specifier comes from, when it is in the change set. */
function importSource(node: Node, fromPath: string, knownOldPaths: Set<string>): string | null {
  let statement = node.parent;
  while (statement && statement.type !== "import_statement") statement = statement.parent;
  const source = statement?.childForFieldName("source");
  return source ? resolveModule(fromPath, source.text.slice(1, -1), knownOldPaths) : null;
}

/** `eval(…)` or a `with` statement makes name resolution unprovable. */
function hasUnsafeScope(root: Node): boolean {
  if (root.descendantsOfType("with_statement").length > 0) return true;
  return root.descendantsOfType("call_expression").some((call) => call?.childForFieldName("function")?.text === "eval");
}
