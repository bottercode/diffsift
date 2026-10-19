/**
 * Normalizes comments and recognizes directive comments: comments that tools act on, such as
 * `@ts-ignore`, lint suppressions, or bundler hints. Directive comments are treated as code, so
 * any change to them counts as real; other comment edits get their own "comment" category.
 */

const DIRECTIVES: RegExp[] = [
  /@ts-(ignore|expect-error|nocheck|check)\b/,
  /^\/\/\/\s*<(reference|amd-module|amd-dependency)\b/,
  /\beslint(-disable|-enable|-env)?\b/,
  /\b(prettier|biome|oxlint|deno-lint|dprint)-ignore\b/,
  /\boxlint-(disable|enable)\b/,
  /[#@]__(PURE|NO_SIDE_EFFECTS|INLINE|NOINLINE|KEY)__/,
  /\bwebpack[A-Z]\w*\s*:/,
  /@vite-ignore\b/,
  /@jsx(Runtime|ImportSource|Frag)?\b/,
  /@flow\b/,
  /@(license|preserve)\b/,
  /^\/\*!/,
  /\b(istanbul|c8|v8)\s+ignore\b/,
  /\bjscs:/,
  /\bglobal\s+\w/,
  /\bsourceMappingURL=/,
  /\bswc-ignore\b/,
];

/** JSDoc tags that carry type information in plain `.js` files checked by TypeScript. */
const JS_TYPE_TAGS = /@(type|param|returns?|typedef|template|satisfies|import|callback|property|prop|enum|this|extends|augments|implements|overload)\b/;

/** True when tooling reads this comment, so changing it can change behavior. */
export function isDirectiveComment(text: string, language: "typescript" | "tsx" | "javascript"): boolean {
  if (text.startsWith("#!")) {
    return true;
  }

  if (DIRECTIVES.some((pattern) => pattern.test(text))) {
    return true;
  }

  return language === "javascript" && text.startsWith("/**") && JS_TYPE_TAGS.test(text);
}

/**
 * Compare-form of a comment: trailing whitespace dropped on every line, leading whitespace
 * dropped on continuation lines, and internal whitespace runs collapsed.
 */
export function normalizeComment(text: string): string {
  return text
    .split(/\r\n|\n|\r/)
    .map((line, index) => {
      const trimmed = (index === 0 ? line : line.trimStart()).trimEnd();
      return trimmed.replace(/[ \t]+/g, " ");
    })
    .join("\n");
}
