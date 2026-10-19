/**
 * Normalizes literal text so formatter rewrites compare equal only when the value is provably
 * the same: string quotes and escapes, number spelling, and JSX text whitespace.
 *
 * Every function returns `null` (or leaves text raw) when it cannot prove equivalence, so the
 * caller falls back to comparing raw text, which can only make a change look more real.
 */

/** Decode the inside of a quoted JS string. Returns `null` for legacy octal or `\8`/`\9` escapes. */
export function cookJsString(inner: string): string | null {
  let out = "";

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (char !== "\\") {
      out += char;
      continue;
    }

    const next = inner[i + 1];
    if (next === undefined) {
      return null;
    }

    i += 1;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        if (/[0-9]/.test(inner[i + 1] ?? "")) return null;
        out += "\0";
        break;
      case "x": {
        const hex = inner.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
        break;
      }
      case "u": {
        const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(inner.slice(i + 1));
        if (braced) {
          const code = Number.parseInt(braced[1]!, 16);
          if (code > 0x10ffff) return null;
          out += String.fromCodePoint(code);
          i += braced[0].length;
          break;
        }

        const hex = inner.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      case "\r":
        // Line continuation; `\r\n` counts as one terminator.
        if (inner[i + 1] === "\n") i += 1;
        break;
      case "\n":
      case " ":
      case " ":
        break;
      default:
        if (/[1-9]/.test(next)) return null;
        // Any other escaped character stands for itself, in strict mode too.
        out += next;
    }
  }

  return out;
}

/** True when `text` is a plain IdentifierName (ASCII-safe subset), usable as an unquoted key. */
export function isIdentifierName(text: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text);
}

/**
 * Spell a number literal the way Prettier prints it, using only value-preserving rewrites:
 * lowercase, drop `_` separators and a `+` exponent sign, drop trailing fraction zeros and a
 * trailing dot, add a leading `0`. Different spellings of the same value (`1e3` vs `1000`) stay
 * different. Legacy octal (`017`) is returned unchanged.
 */
export function canonicalNumber(raw: string): string {
  if (/^0[0-9]/.test(raw)) {
    return raw;
  }

  let text = raw.toLowerCase().replaceAll("_", "");
  if (/^0[xob]/.test(text) || text.endsWith("n")) {
    return text;
  }

  text = text.replace(/e\+/, "e");
  const match = /^(\d*)(?:\.(\d*))?(e-?\d+)?$/.exec(text);
  if (!match) {
    return text;
  }

  const whole = match[1] === "" ? "0" : match[1]!;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}${match[3] ?? ""}`;
}

/**
 * Collapse JSX text the way React's compilers do (Babel's `cleanJSXElementLiteralChild`):
 * whitespace that includes a line break is removed, and other runs keep their meaning.
 * Returns the text React would render; an empty result means the text produces no child.
 */
export function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = -1;
  lines.forEach((line, index) => {
    if (/[^ \t]/.test(line)) lastNonEmpty = index;
  });

  let out = "";
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/g, " ");
    if (index !== 0) trimmed = trimmed.replace(/^ +/, "");
    if (index !== lines.length - 1) trimmed = trimmed.replace(/ +$/, "");
    if (trimmed) {
      out += index === lastNonEmpty ? trimmed : `${trimmed} `;
    }
  });

  return out;
}
