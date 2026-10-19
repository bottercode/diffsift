import { describe, expect, test } from "bun:test";
import type { Grammar } from "./languages";
import { createTestTokens, testKeys } from "../test/helpers";

interface Case {
  name: string;
  a: string;
  b: string;
  grammar?: Grammar;
}

/** Pairs a formatter can produce from each other: they must tokenize identically. */
const equivalent: Case[] = [
  { name: "whitespace and line wrapping", a: "foo(a, b)", b: "foo(\n  a,\n  b\n)" },
  { name: "line endings", a: "const a = 1;\nconst b = 2;\n", b: "const a = 1;\r\nconst b = 2;\r\n" },
  { name: "semicolons vs ASI", a: "const a = 1;\nfoo();\nreturn a;", b: "const a = 1\nfoo()\nreturn a" },
  { name: "semicolon-free leading semicolon", a: "foo();\n[a, b] = c;", b: "foo()\n;[a, b] = c" },
  { name: "stray semicolons in blocks", a: "function f() { a(); }", b: "function f() { a();; };" },
  { name: "class field semicolons", a: "class A { x = 1; y = 2; m() {} }", b: "class A { x = 1\n y = 2\n m() {}; }" },
  { name: "string quotes", a: "const s = 'it\\'s';", b: 'const s = "it\'s";' },
  { name: "escape spelling", a: 'const s = "\\x41";', b: 'const s = "A";' },
  { name: "trailing commas", a: "f(a, b);\nconst o = { a, b };\nconst [x, y] = z;", b: "f(a, b,);\nconst o = { a, b, };\nconst [x, y,] = z;" },
  { name: "trailing comma in imports and enums", a: 'import { a, b } from "m";\nenum E { A, B }', b: 'import { a, b, } from "m";\nenum E { A, B, }' },
  { name: "parens around a returned value", a: "function f() { return <div />; }", b: "function f() {\n  return (\n    <div />\n  );\n}", grammar: "tsx" },
  { name: "parens around an initializer", a: "const a = b + c;", b: "const a = (b + c);" },
  { name: "single arrow parameter parens", a: "const f = (x) => x;", b: "const f = x => x;" },
  { name: "number spelling", a: "const n = 0.5;", b: "const n = .5;" },
  { name: "quoted object keys", a: "const o = { a: 1 };", b: "const o = { 'a': 1 };" },
  { name: "interface separators", a: "interface I { a: string; b: number; }", b: "interface I {\n  a: string,\n  b: number\n}" },
  { name: "object type separators", a: "type O = { a: 1; b: 2 };", b: "type O = { a: 1, b: 2, };" },
  { name: "leading union bar", a: "type U = A | B;", b: "type U =\n  | A\n  | B;" },
  { name: "directive prologue quotes", a: '"use strict";\nf();', b: "'use strict';\nf();" },
  { name: "JSX text reindented", a: "const x = <p>\n  hello\n</p>;", b: "const x = <p>\n      hello\n    </p>;", grammar: "tsx" },
  { name: "comment reindent", a: "/**\n * a\n */\nf();", b: "/**\n   * a\n   */\nf();" },
];

/** Pairs that look similar but mean different things: they must not tokenize identically. */
const different: Case[] = [
  { name: "ASI call hazard", a: "a\n(b)", b: "a;\n(b)" },
  { name: "return on its own line", a: "function f() { return x; }", b: "function f() { return\nx; }" },
  { name: "template literal whitespace", a: "const t = `a b`;", b: "const t = `a  b`;" },
  { name: "template vs string", a: "const t = `a`;", b: "const t = 'a';" },
  { name: "array holes", a: "const a = [x, ,];", b: "const a = [x,];" },
  { name: "array hole only element", a: "const a = [,];", b: "const a = [];" },
  { name: "parens around a sequence", a: "const a = (b, c);", b: "const a = b, c;" },
  { name: "optional chain parens", a: "(a?.b)();", b: "a?.b();" },
  { name: "operator change", a: "const ok = a < b;", b: "const ok = a <= b;" },
  { name: "different string value", a: "const s = 'a';", b: "const s = 'b';" },
  { name: "legacy octal escape vs character", a: "const s = '\\101';", b: "const s = 'A';" },
  { name: "number value spelling", a: "const n = 1e3;", b: "const n = 1000;" },
  { name: "bracket vs dot access", a: "a['b'];", b: "a.b;" },
  { name: "quoted class member key", a: "class A { 'constructor'() {} }", b: "class A { constructor() {} }" },
  { name: "typed arrow parameter", a: "const f = (x: T) => x;", b: "const f = x => x;" },
  { name: "JSX attribute escapes are literal", a: 'const x = <a t="\\x41" />;', b: 'const x = <a t="A" />;', grammar: "tsx" },
  { name: "JSX text loses a space", a: "const x = <p>hi {name}</p>;", b: "const x = <p>hi\n{name}</p>;", grammar: "tsx" },
  { name: "directive vs escaped directive", a: "'use strict';\nf();", b: "'use\\x20strict';\nf();" },
  { name: "directive comment edit", a: "// @ts-ignore\nf();", b: "// @ts-expect-error\nf();" },
  { name: "statement reorder", a: "a();\nb();", b: "b();\na();" },
  { name: "empty if body", a: "if (x);\ny();", b: "if (x)\ny();" },
];

describe("tokenize: formatter-equivalent pairs compare equal", () => {
  for (const { name, a, b, grammar } of equivalent) {
    test(name, async () => {
      const keysA = (await testKeys(a, grammar)).filter((key) => !key.startsWith("comment"));
      const keysB = (await testKeys(b, grammar)).filter((key) => !key.startsWith("comment"));
      expect(keysB).toEqual(keysA);
    });
  }
});

describe("tokenize: different programs never compare equal", () => {
  for (const { name, a, b, grammar } of different) {
    test(name, async () => {
      expect(await testKeys(b, grammar)).not.toEqual(await testKeys(a, grammar));
    });
  }
});

describe("tokenize: bookkeeping", () => {
  test("records dropped punctuation with its position", async () => {
    const { dropped } = await createTestTokens("f(a, b,);");
    expect(dropped.map((entry) => entry.rule).sort()).toEqual(["semicolons", "trailing-commas"]);
  });

  test("keeps comment tokens in their own channel", async () => {
    const { tokens } = await createTestTokens("// hello\nf();");
    expect(tokens[0]!.kind).toBe("comment");
    expect(tokens.at(-1)!.kind).toBe("end");
  });

  test("identifier tokens carry their syntax node", async () => {
    const { tokens } = await createTestTokens("const user = getUser(id);");
    const names = tokens.filter((token) => token.node).map((token) => token.raw);
    expect(names).toEqual(["user", "getUser", "id"]);
  });
});
