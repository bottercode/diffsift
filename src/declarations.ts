/**
 * Finds the named declarations in a file (functions, classes and their members, single-name
 * variables, types, interfaces, enums, namespaces) and fingerprints each one so moved code can
 * be recognized in another place or another file.
 *
 * A declaration's range includes its `export` keyword and the comments directly above it, so a
 * function moved together with its JSDoc is recognized as one unit. Fingerprints are the
 * declaration's comparison keys joined into a string; `fpBody` replaces the declaration's own
 * name with a placeholder so a renamed-and-moved declaration can still be paired.
 */

import type { Node } from "web-tree-sitter";
import { lineSpan } from "./lines";
import type { ParsedFile } from "./parser";
import type { TokenStream } from "./tokens";
import { indexLines } from "./lines";

export type DeclKind =
  | "function"
  | "class"
  | "method"
  | "getter"
  | "setter"
  | "field"
  | "const"
  | "let"
  | "var"
  | "type"
  | "interface"
  | "enum"
  | "namespace";

export interface Decl {
  kind: DeclKind;
  name: string;
  /** `Class.member` for class members, otherwise the name. */
  qualifiedName: string;
  exported: boolean;
  /** Module-level (or a member of a module-level class). */
  topLevel: boolean;
  /** Token index range `[start, end)`, including `export` and attached leading comments. */
  tokens: [number, number];
  /** Token index of the declaration's name. */
  nameToken: number;
  /** Token index of the `export` keyword when the declaration is exported directly. */
  exportToken?: number;
  startLine: number;
  endLine: number;
  fpExact: string;
  fpBody: string;
  /**
   * Safe to move to another file: hoisted functions, erased types, class methods, classes, and
   * constants initialized with a function, class, or literal (initializing them runs no code).
   */
  orderInsensitive: boolean;
  /**
   * Safe to reorder within a file as well: hoisted functions, erased types, and class methods.
   * Classes and constants are excluded because a module-level use between the old and new
   * position would hit the temporal dead zone.
   */
  hoisted: boolean;
}

const HOISTED_KINDS = new Set<DeclKind>(["function", "type", "interface", "method", "getter", "setter"]);

const FUNCTION_TYPES = new Set(["function_declaration", "generator_function_declaration"]);
const CLASS_TYPES = new Set(["class_declaration", "abstract_class_declaration"]);
const SAFE_INITIALIZERS = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
  "class",
  "string",
  "number",
  "true",
  "false",
  "null",
  "undefined",
  "template_string",
]);

/** Extract declarations with fingerprints from one parsed, tokenized side of a file. */
export function extractDeclarations(parsed: ParsedFile, stream: TokenStream, _path: string): Decl[] {
  const lines = indexLines(parsed.text);
  const decls: Decl[] = [];
  const tokens = stream.tokens;

  /** First token index with `start >= offset`. */
  const firstTokenAt = (offset: number) => {
    let low = 0;
    let high = tokens.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tokens[mid]!.start < offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  /** Token range covering `[start, end]`, including zero-width tokens at `end`. */
  const tokenRange = (start: number, end: number): [number, number] => {
    const first = firstTokenAt(start);
    let last = first;
    while (last < tokens.length && tokens[last]!.start <= end && tokens[last]!.end <= end) last += 1;
    return [first, last];
  };

  const tokenAt = (node: Node) => {
    const index = firstTokenAt(node.startIndex);
    return tokens[index]?.start === node.startIndex ? index : -1;
  };

  const add = (kind: DeclKind, nameNode: Node | null, rangeNode: Node, owner: string | null, topLevel: boolean, exportNode: Node | null) => {
    if (!nameNode) return;
    const nameToken = tokenAt(nameNode);
    if (nameToken === -1) return;

    const start = leadingCommentStart(rangeNode);
    const range = tokenRange(start, rangeNode.endIndex);
    const name = nameNode.text;
    const keys = tokens.slice(range[0], range[1]).map((token) => token.key);
    const bodyKeys = keys.map((key, index) => (range[0] + index === nameToken ? "\u0002name" : key));
    const [startLine, endLine] = lineSpan(lines, start, rangeNode.endIndex);

    decls.push({
      kind,
      name,
      qualifiedName: owner ? `${owner}.${name}` : name,
      exported: exportNode !== null,
      topLevel,
      tokens: range,
      nameToken,
      ...(exportNode ? { exportToken: tokenAt(exportNode) } : {}),
      startLine,
      endLine,
      fpExact: keys.join("\u0003"),
      fpBody: bodyKeys.join("\u0003"),
      orderInsensitive: isOrderInsensitive(kind, rangeNode),
      hoisted: HOISTED_KINDS.has(kind),
    });
  };

  const visitStatement = (statement: Node, topLevel: boolean) => {
    const exportNode = statement.type === "export_statement" ? statement : null;
    const node = exportNode ? exportNode.childForFieldName("declaration") : statement;
    if (!node) return;
    const rangeNode = exportNode ?? node;
    const exportKeyword = exportNode?.firstChild?.type === "export" ? exportNode.firstChild : null;

    if (FUNCTION_TYPES.has(node.type)) {
      add("function", node.childForFieldName("name"), rangeNode, null, topLevel, exportKeyword);
    } else if (CLASS_TYPES.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      add("class", nameNode, rangeNode, null, topLevel, exportKeyword);
      const body = node.childForFieldName("body");
      if (nameNode && body) visitClassBody(body, nameNode.text, topLevel);
    } else if (node.type === "interface_declaration") {
      add("interface", node.childForFieldName("name"), rangeNode, null, topLevel, exportKeyword);
    } else if (node.type === "type_alias_declaration") {
      add("type", node.childForFieldName("name"), rangeNode, null, topLevel, exportKeyword);
    } else if (node.type === "enum_declaration") {
      add("enum", node.childForFieldName("name"), rangeNode, null, topLevel, exportKeyword);
    } else if (node.type === "internal_module" || node.type === "module") {
      add("namespace", node.childForFieldName("name"), rangeNode, null, topLevel, exportKeyword);
    } else if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      const declarators = node.namedChildren.filter((child) => child?.type === "variable_declarator");
      if (declarators.length !== 1) return;
      const nameNode = declarators[0]!.childForFieldName("name");
      if (nameNode?.type !== "identifier") return;
      const keyword = node.firstChild?.text;
      const kind: DeclKind = keyword === "const" ? "const" : keyword === "let" ? "let" : "var";
      add(kind, nameNode, rangeNode, null, topLevel, exportKeyword);
    }
  };

  const visitClassBody = (body: Node, owner: string, topLevel: boolean) => {
    for (const member of body.namedChildren) {
      if (!member) continue;
      if (member.type === "method_definition") {
        const keyword = member.children.find((child) => child?.type === "get" || child?.type === "set")?.type;
        add(keyword === "get" ? "getter" : keyword === "set" ? "setter" : "method", member.childForFieldName("name"), member, owner, topLevel, null);
      } else if (member.type === "public_field_definition") {
        add("field", member.childForFieldName("name"), member, owner, topLevel, null);
      }
    }
  };

  for (const statement of parsed.tree.rootNode.namedChildren) {
    if (statement) visitStatement(statement, true);
  }

  return decls.sort((a, b) => a.tokens[0] - b.tokens[0]);
}

/** Start offset including comments directly above a node, with no blank line in between. */
function leadingCommentStart(node: Node): number {
  let start = node.startIndex;
  let current = node;
  let previous = node.previousSibling;

  while (previous && previous.type === "comment" && previous.endPosition.row >= current.startPosition.row - 1 && previous.endPosition.row < current.startPosition.row) {
    start = previous.startIndex;
    current = previous;
    previous = previous.previousSibling;
  }

  return start;
}

/** Decide whether a declaration can move without changing when code runs. */
function isOrderInsensitive(kind: DeclKind, rangeNode: Node): boolean {
  switch (kind) {
    case "function":
    case "type":
    case "interface":
    case "method":
    case "getter":
    case "setter":
      return true;
    case "class":
      return true;
    case "const":
    case "let":
    case "var": {
      const declarator = (rangeNode.type === "export_statement" ? rangeNode.childForFieldName("declaration") : rangeNode)?.namedChildren.find(
        (child) => child?.type === "variable_declarator",
      );
      const value = declarator?.childForFieldName("value");
      return value ? SAFE_INITIALIZERS.has(value.type) : false;
    }
    default:
      return false;
  }
}
