/**
 * Resolves relative import specifiers to files in the change set, the way TypeScript and
 * bundlers do: exact path, added extensions, `/index.*`, and TypeScript's `.js` → `.ts` mapping.
 * Bare specifiers (`react`, `node:fs`) never resolve; they point outside the change set.
 *
 * Paths are git-style POSIX paths, so this uses its own path helpers instead of `node:path`
 * and stays usable in browsers.
 */

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** Resolve `specifier` imported from `fromPath` to one of `knownPaths`, or `null`. */
export function resolveModule(fromPath: string, specifier: string, knownPaths: ReadonlySet<string>): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && specifier !== "." && specifier !== "..") {
    return null;
  }

  const base = normalizePath(`${dirname(fromPath)}/${specifier}`);
  if (base === null) {
    return null;
  }

  const candidates = [base, ...EXTENSIONS.map((extension) => base + extension), ...EXTENSIONS.map((extension) => `${base}/index${extension}`)];
  for (const [jsExtension, tsExtensions] of Object.entries(JS_TO_TS)) {
    if (base.endsWith(jsExtension)) {
      const stem = base.slice(0, -jsExtension.length);
      candidates.push(...tsExtensions.map((extension) => stem + extension));
    }
  }

  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

/** Directory part of a POSIX path (`""` for a top-level file). */
function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Collapse `.` and `..` segments; `null` when the path escapes the repository root. */
export function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  return parts.join("/");
}
