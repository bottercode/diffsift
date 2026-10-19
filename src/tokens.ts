/**
 * Turns a tree-sitter syntax tree into the normalized token stream that every comparison in
 * diffsift runs on. Two token streams are equal exactly when the files differ only in ways a
 * formatter may change without changing behavior.
 *
 * Each code token is keyed by its normalized text plus the type of its nearest meaningful
 * parent, so the same characters in a different structure never compare equal. Statement ends
 * are explicit `end` tokens (whether the source wrote `;` or relied on ASI), which keeps ASI
 * hazards like `a\n(b)` vs `a;\n(b)` different. Dropped punctuation is recorded with its
 * position so reports can say which kind of formatting changed on which lines.
 */

import type { Node, Tree } from "web-tree-sitter";
import { isDirectiveComment, normalizeComment } from "./comments";
import type { Grammar } from "./languages";
import { canonicalNumber, cleanJsxText, cookJsString, isIdentifierName } from "./literals";

export type TokenKind = "code" | "comment" | "end";

export type FormatRule =
  | "semicolons"
  | "trailing-commas"
  | "quotes"
  | "parens"
  | "numbers"
  | "key-quotes"
  | "separators"
  | "jsx-whitespace";

export interface Token {
  kind: TokenKind;
  /** Comparison key: kind, normalized text, and structural parent. */
  key: string;
  /** Source text this token covers (empty for synthetic `end` tokens). */
  raw: string;
  /** Offsets into the source; synthetic tokens are zero-width at their statement's end. */
  start: number;
  end: number;
  /** Set for identifier-like leaves, so scope analysis can resolve them. */
  node?: Node;
}

/** Punctuation the tokenizer dropped because a formatter may add or remove it freely. */
export interface DroppedToken {
  rule: FormatRule;
  start: number;
  end: number;
}

export interface TokenStream {
  tokens: Token[];
  dropped: DroppedToken[];
}

/** Statements whose `;` is optional (ASI) and that therefore get a synthetic `end` token. */
const STATEMENTS = new Set([
  "expression_statement",
  "lexical_declaration",
  "variable_declaration",
  "return_statement",
  "throw_statement",
  "break_statement",
  "continue_statement",
  "do_statement",
  "debugger_statement",
  "import_statement",
  "type_alias_declaration",
  "function_signature",
  "import_alias",
]);

/** Class members that end with an optional `;` written as a `class_body` child. */
const CLASS_FIELD_MEMBERS = new Set(["public_field_definition", "abstract_method_signature", "method_signature", "index_signature"]);

/** Members of interfaces and object types, separated by `;`, `,`, or a bare newline. */
const TYPE_MEMBERS = new Set(["property_signature", "method_signature", "call_signature", "construct_signature", "index_signature"]);

/** Parents in which a stray `;` (an `empty_statement`) does nothing. */
const EMPTY_STATEMENT_PARENTS = new Set(["program", "statement_block", "class_body", "switch_case", "switch_default"]);

const CLOSERS = new Set(["]", "}", ")", ">"]);

/** Places where parentheses around a whole expression never change its meaning. */
const PAREN_VALUE_SLOTS: Record<string, string | null> = {
  return_statement: null,
  arguments: null,
  array: null,
  jsx_expression: null,
  template_substitution: null,
  arrow_function: "body",
  variable_declarator: "value",
  assignment_expression: "right",
  pair: "value",
  public_field_definition: "value",
};

/** Contexts where a quoted key and an identifier key name the same property. */
const KEY_PARENTS = new Set(["pair", "pair_pattern", "property_signature", "enum_body", "enum_assignment"]);

const IDENTIFIER_LEAVES = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "private_property_identifier",
  "statement_identifier",
]);

/** Tokenize a parsed file. Callers only tokenize trees without syntax errors. */
export function tokenize(tree: Tree, text: string, grammar: Grammar): TokenStream {
  const tokens: Token[] = [];
  const dropped: DroppedToken[] = [];
  const drop = (rule: FormatRule, node: Node) => dropped.push({ rule, start: node.startIndex, end: node.endIndex });

  const push = (kind: TokenKind, norm: string, parentType: string, start: number, end: number, node?: Node) => {
    tokens.push({ kind, key: `${kind}\u0001${norm}\u0001${parentType}`, raw: text.slice(start, end), start, end, node });
  };

  const directivePrologue = collectDirectivePrologue(tree.rootNode);

  /** Depth-first walk; returns after emitting any closing synthetic token for `node`. */
  const visit = (node: Node) => {
    const type = node.type;

    if (type === "comment" || type === "html_comment") {
      const raw = text.slice(node.startIndex, node.endIndex);
      if (isDirectiveComment(raw, grammar)) {
        push("code", `C:${raw}`, parentTypeOf(node), node.startIndex, node.endIndex);
      } else {
        push("comment", normalizeComment(raw), "", node.startIndex, node.endIndex);
      }
      return;
    }

    if (type === "hash_bang_line") {
      push("code", text.slice(node.startIndex, node.endIndex), "program", node.startIndex, node.endIndex);
      return;
    }

    if (type === "empty_statement" && EMPTY_STATEMENT_PARENTS.has(node.parent?.type ?? "")) {
      drop("semicolons", node);
      return;
    }

    if (type === "string") {
      emitString(node);
      return;
    }

    if (type === "jsx_text") {
      const raw = text.slice(node.startIndex, node.endIndex);
      const cleaned = cleanJsxText(raw);
      if (cleaned === "") drop("jsx-whitespace", node);
      if (cleaned !== "") push("code", `X:${cleaned}`, parentTypeOf(node), node.startIndex, node.endIndex);
      return;
    }

    if (node.childCount === 0) {
      emitLeaf(node);
      return;
    }

    for (const child of node.children) {
      if (child) visit(child);
    }

    if (STATEMENTS.has(type) || (type === "export_statement" && node.childForFieldName("declaration") === null)) {
      push("end", "", type, node.endIndex, node.endIndex);
    } else if (CLASS_FIELD_MEMBERS.has(type) && node.parent?.type === "class_body") {
      push("end", "", type, node.endIndex, node.endIndex);
    } else if (TYPE_MEMBERS.has(type) && (node.parent?.type === "interface_body" || node.parent?.type === "object_type")) {
      push("end", "", "member", node.endIndex, node.endIndex);
    }
  };

  /** Emit one leaf token, dropping punctuation a formatter is free to add or remove. */
  const emitLeaf = (node: Node) => {
    const type = node.type;
    const parent = node.parent;
    const parentType = parent?.type ?? "";
    const raw = text.slice(node.startIndex, node.endIndex);

    if (node.isMissing || raw === "") {
      return;
    }

    if (type === ";") {
      if (STATEMENTS.has(parentType) || parentType === "export_statement" || parentType === "class_body") {
        drop("semicolons", node);
        return;
      }
    }

    if ((type === ";" || type === ",") && (parentType === "interface_body" || parentType === "object_type")) {
      drop("separators", node);
      return;
    }

    if (type === "," && parent && isTrailingComma(node)) {
      drop("trailing-commas", node);
      return;
    }

    if ((type === "(" || type === ")") && parent && (isTransparentParens(parent) || isSingleArrowParam(parent))) {
      drop("parens", node);
      return;
    }

    if ((type === "|" || type === "&") && (parentType === "union_type" || parentType === "intersection_type") && parent?.firstChild?.equals(node)) {
      drop("separators", node);
      return;
    }

    if (type === "number") {
      const norm = canonicalNumber(raw);
      push("code", `N:${norm}`, parentTypeOf(node), node.startIndex, node.endIndex);
      return;
    }

    if (type === "property_identifier" && KEY_PARENTS.has(parentType) && isKeyPosition(node)) {
      push("code", `K:${raw}`, parentTypeOf(node), node.startIndex, node.endIndex, node);
      return;
    }

    push("code", raw, parentTypeOf(node), node.startIndex, node.endIndex, IDENTIFIER_LEAVES.has(type) ? node : undefined);
  };

  /** Emit a JS string literal as one token, comparing by value wherever that is safe. */
  const emitString = (node: Node) => {
    const raw = text.slice(node.startIndex, node.endIndex);
    const inner = raw.slice(1, -1);
    const parentType = parentTypeOf(node);
    const literalParent = node.parent?.type ?? "";

    // JSX attributes have no escape processing, and directive prologues ("use strict") are
    // recognized by their exact source text, so both compare by raw inner text.
    if (literalParent === "jsx_attribute" || directivePrologue.has(node.startIndex)) {
      push("code", `R:${inner}`, parentType, node.startIndex, node.endIndex);
      return;
    }

    const cooked = cookJsString(inner);
    if (cooked === null) {
      push("code", `R:${inner}`, parentType, node.startIndex, node.endIndex);
      return;
    }

    if (KEY_PARENTS.has(literalParent) && isKeyPosition(node) && isIdentifierName(cooked) && !inner.includes("\\")) {
      push("code", `K:${cooked}`, parentType, node.startIndex, node.endIndex);
      return;
    }

    push("code", `S:${JSON.stringify(cooked)}`, parentType, node.startIndex, node.endIndex);
  };

  visit(tree.rootNode);
  return { tokens, dropped };
}

/** Nearest ancestor type, looking through parentheses and arrow-parameter wrappers that are dropped. */
function parentTypeOf(node: Node): string {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "parenthesized_expression" && isTransparentParens(parent)) {
      parent = parent.parent;
      continue;
    }

    if ((parent.type === "required_parameter" || parent.type === "formal_parameters") && isInsideSingleArrowParam(parent)) {
      parent = parent.type === "formal_parameters" ? parent.parent : parent.parent?.parent ?? null;
      continue;
    }

    return parent.type;
  }

  return "";
}

/** True when `(expr)` sits in a value slot and does not wrap a comma sequence. */
function isTransparentParens(node: Node): boolean {
  if (node.type !== "parenthesized_expression") {
    return false;
  }

  const parent = node.parent;
  if (!parent || !(parent.type in PAREN_VALUE_SLOTS)) {
    return false;
  }

  const field = PAREN_VALUE_SLOTS[parent.type];
  if (field !== null && !parent.childForFieldName(field!)?.equals(node)) {
    return false;
  }

  const inner = node.namedChildren.filter((child) => child && child.type !== "comment");
  return inner.length === 1 && inner[0]!.type !== "sequence_expression";
}

/** `(x) =>` with one plain parameter, which prints the same as `x =>`. */
function isSingleArrowParam(node: Node): boolean {
  if (node.type !== "formal_parameters" || node.parent?.type !== "arrow_function") {
    return false;
  }

  const params = node.namedChildren.filter((child) => child && child.type !== "comment");
  if (params.length !== 1) {
    return false;
  }

  const param = params[0]!;
  if (param.type === "identifier") {
    return true;
  }

  return param.type === "required_parameter" && param.childCount === 1 && param.firstChild?.type === "identifier";
}

/** Whether a wrapper node belongs to a single plain arrow parameter. */
function isInsideSingleArrowParam(node: Node): boolean {
  if (node.type === "formal_parameters") {
    return isSingleArrowParam(node);
  }

  return node.type === "required_parameter" && node.parent !== null && isSingleArrowParam(node.parent);
}

/** A `,` right before a closing bracket, unless it creates an array hole (`[a,,]`, `[,]`). */
function isTrailingComma(node: Node): boolean {
  let next = node.nextSibling;
  while (next && next.type === "comment") {
    next = next.nextSibling;
  }

  if (!next || !CLOSERS.has(next.type)) {
    return false;
  }

  let previous = node.previousSibling;
  while (previous && previous.type === "comment") {
    previous = previous.previousSibling;
  }

  return previous !== null && previous.type !== "," && previous.type !== "[";
}

/** True when a property name or string sits in the key position of its parent. */
function isKeyPosition(node: Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  if (parent.type === "enum_body") {
    return true;
  }

  const key = parent.childForFieldName(parent.type === "enum_assignment" ? "name" : parent.type === "property_signature" ? "name" : "key");
  return key?.equals(node) ?? false;
}

/** Start offsets of string literals that form directive prologues (`"use strict"`, `"use client"`). */
function collectDirectivePrologue(root: Node): Set<number> {
  const starts = new Set<number>();

  const scan = (body: Node | null) => {
    if (!body) return;
    for (const statement of body.namedChildren) {
      if (!statement || statement.type === "comment") continue;
      const expression = statement.type === "expression_statement" ? statement.namedChild(0) : null;
      if (!expression || expression.type !== "string") return;
      starts.add(expression.startIndex);
    }
  };

  scan(root);
  for (const body of root.descendantsOfType("statement_block")) {
    if (body && /function|method|arrow/.test(body.parent?.type ?? "")) scan(body);
  }

  return starts;
}
