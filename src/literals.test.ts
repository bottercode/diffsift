import { describe, expect, test } from "bun:test";
import { isDirectiveComment, normalizeComment } from "./comments";
import { canonicalNumber, cleanJsxText, cookJsString, isIdentifierName } from "./literals";

describe("cookJsString", () => {
  test("decodes the escapes formatters rewrite", () => {
    expect(cookJsString("it\\'s")).toBe("it's");
    expect(cookJsString('say \\"hi\\"')).toBe('say "hi"');
    expect(cookJsString("a\\nb\\tc")).toBe("a\nb\tc");
    expect(cookJsString("\\x41\\u0042\\u{43}")).toBe("ABC");
    expect(cookJsString("\\q")).toBe("q");
    expect(cookJsString("line\\\ncontinued")).toBe("linecontinued");
  });

  test("refuses escapes whose meaning depends on legacy rules", () => {
    expect(cookJsString("\\01")).toBeNull();
    expect(cookJsString("\\7")).toBeNull();
    expect(cookJsString("\\8")).toBeNull();
    expect(cookJsString("\\xZZ")).toBeNull();
    expect(cookJsString("\\u{110000}")).toBeNull();
  });

  test("keeps different values different", () => {
    expect(cookJsString("a")).not.toBe(cookJsString("b"));
    expect(cookJsString("\\0")).not.toBe(cookJsString("0"));
  });
});

describe("canonicalNumber", () => {
  test("equates spellings Prettier produces for the same value", () => {
    expect(canonicalNumber(".5")).toBe(canonicalNumber("0.5"));
    expect(canonicalNumber("1.50")).toBe(canonicalNumber("1.5"));
    expect(canonicalNumber("1.")).toBe(canonicalNumber("1"));
    expect(canonicalNumber("1E+3")).toBe(canonicalNumber("1e3"));
    expect(canonicalNumber("0XFF")).toBe(canonicalNumber("0xff"));
    expect(canonicalNumber("1_000")).toBe(canonicalNumber("1000"));
  });

  test("keeps different spellings of the same value and legacy octal apart", () => {
    expect(canonicalNumber("1e3")).not.toBe(canonicalNumber("1000"));
    expect(canonicalNumber("0xff")).not.toBe(canonicalNumber("255"));
    expect(canonicalNumber("017")).toBe("017");
    expect(canonicalNumber("10n")).not.toBe(canonicalNumber("10"));
  });
});

describe("cleanJsxText", () => {
  test("drops whitespace that contains a line break", () => {
    expect(cleanJsxText("\n      hello\n    ")).toBe("hello");
    expect(cleanJsxText("\n   ")).toBe("");
    expect(cleanJsxText("a\n  b")).toBe("a b");
  });

  test("keeps same-line spaces, which React renders", () => {
    expect(cleanJsxText("hello ")).toBe("hello ");
    expect(cleanJsxText("hello\n")).toBe("hello");
  });
});

describe("comments", () => {
  test("normalizes reindented and trailing whitespace", () => {
    expect(normalizeComment("/**\n   * a  b   \n   */")).toBe(normalizeComment("/**\n * a b\n */"));
    expect(normalizeComment("// x")).not.toBe(normalizeComment("// y"));
  });

  test("recognizes directive comments", () => {
    for (const text of ["// @ts-ignore", "/* eslint-disable */", "// prettier-ignore", "/* #__PURE__ */", "/// <reference types=\"node\" />", "#!/usr/bin/env node", "/*! license */"]) {
      expect(isDirectiveComment(text, "typescript")).toBe(true);
    }

    expect(isDirectiveComment("/** @param {string} a */", "javascript")).toBe(true);
    expect(isDirectiveComment("/** @param a the user */", "typescript")).toBe(false);
    expect(isDirectiveComment("// fetch the user", "typescript")).toBe(false);
  });

  test("identifier names", () => {
    expect(isIdentifierName("getUser")).toBe(true);
    expect(isIdentifierName("data-id")).toBe(false);
    expect(isIdentifierName("1a")).toBe(false);
  });
});
