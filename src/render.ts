/**
 * Prints a result for people: one summary line, then what was mechanical (renames, moves,
 * formatting), then every real change with its code. Moves edited in place get a warning mark
 * and show the edited lines, because that is the change reviewers miss most often.
 */

import type { FilePair, SiftResult, Side } from "./types";

export interface RenderOptions {
  color: boolean;
  /** Source of line text for snippets; real changes print without code when absent. */
  pairs?: readonly FilePair[];
  /** Show only real changes. */
  onlyReal?: boolean;
  /** Most real changes to list before summarizing the rest. */
  limit?: number;
  label?: string;
}

/** Whether to use color, from flags and the environment (`NO_COLOR`, `FORCE_COLOR`, TTY). */
export function shouldColor(flag: boolean | undefined, isTTY: boolean, env: Record<string, string | undefined>): boolean {
  if (flag !== undefined) return flag;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return isTTY;
}

/** Render a result as text. */
export function renderText(result: SiftResult, options: RenderOptions): string {
  const paint = (code: string) => (text: string) => (options.color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const green = paint("32");
  const yellow = paint("33");
  const red = paint("31");
  const dim = paint("2");
  const bold = paint("1");
  const lines: string[] = [];
  const lineText = createLineReader(options.pairs ?? []);
  const { summary } = result;
  const analyzedChanged = summary.byCategory.format + summary.byCategory.rename + summary.byCategory.move + summary.byCategory.real;
  const mechanical = summary.byCategory.format + summary.byCategory.rename + summary.byCategory.move;

  lines.push(
    bold(
      `diffsift ${options.label ?? sourceLabel(result)} · ${plural(summary.files, "file")} · ${plural(summary.changedLines, "changed line")} · ${mechanical} mechanical (${Math.round(summary.mechanicalRatio * 100)}%)`,
    ),
  );

  if (!options.onlyReal) {
    for (const rename of result.renames) {
      const files = new Set(rename.occurrences.map((occurrence) => occurrence.file)).size;
      lines.push(`  ${green("✓ rename")}  ${rename.from} → ${rename.to}   ${dim(`${plural(rename.count, "place")} in ${plural(files, "file")}${rename.exported ? ", exported" : ""}`)}`);
    }

    for (const move of result.moves) {
      const where = move.from.file === move.to.file ? dim(`within ${move.from.file}`) : `${dim(move.from.file)} → ${move.to.file}`;
      if (!move.changedInside) {
        lines.push(`  ${green("✓ move")}    ${move.symbol}  ${where}`);
        continue;
      }

      lines.push(`  ${yellow("⚠ move")}    ${move.symbol}  ${where}   ${yellow("changed while moving")}`);
      for (const changed of move.changedLines) {
        const text = lineText(changed.file, changed.side, changed.line);
        lines.push(`            ${changed.side === "old" ? red("-") : green("+")} ${dim(`${changed.file}:${changed.line}`)}  ${text?.trim() ?? ""}`);
      }
    }

    const formatOnly = result.formatFiles.filter((file) => file.formatOnly);
    const formatSome = result.formatFiles.filter((file) => !file.formatOnly);
    if (formatOnly.length > 0) {
      lines.push(`  ${green("✓ format")}  ${listFiles(formatOnly.map((file) => file.file))}   ${dim(kindsOf(formatOnly))}`);
    }
    if (formatSome.length > 0) {
      const count = formatSome.reduce((total, file) => total + file.lines, 0);
      lines.push(`  ${green("✓ format")}  ${plural(count, "line")} in ${listFiles(formatSome.map((file) => file.file))}   ${dim(kindsOf(formatSome))}`);
    }
    if (summary.byCategory.comment > 0) {
      lines.push(`  ${dim(`· comments  ${plural(summary.byCategory.comment, "line")} changed only comments`)}`);
    }
  }

  lines.push("");
  lines.push(bold(summary.realLines === 0 ? green("No real changes.") : red(`Real changes: ${plural(summary.realLines, "line")}`)));

  const limit = options.limit ?? 30;
  for (const change of result.realChanges.slice(0, limit)) {
    const span = change.endLine === change.line ? `${change.line}` : `${change.line}-${change.endLine}`;
    const where = `${change.file}:${span}${change.side === "old" ? " (removed)" : ""}`;
    const symbol = change.symbol ? dim(`  in ${change.symbol}`) : "";
    const reason = change.reason === "changed" ? "" : dim(`  [${change.reason}]`);
    lines.push(`  ${where}${symbol}${reason}`);
    const text = lineText(change.file, change.side, change.line);
    if (text !== undefined && change.reason === "changed") {
      lines.push(`    ${change.side === "old" ? red("-") : green("+")} ${text.trim()}`);
    }
  }
  if (result.realChanges.length > limit) {
    lines.push(dim(`  … and ${result.realChanges.length - limit} more (use --json for all)`));
  }

  const skipped = result.diagnostics;
  if (skipped.length > 0) {
    lines.push("");
    const byCode = new Map<string, string[]>();
    for (const diagnostic of skipped) {
      const list = byCode.get(diagnostic.code) ?? [];
      list.push(diagnostic.file ?? "");
      byCode.set(diagnostic.code, list);
    }
    for (const [code, files] of byCode) {
      lines.push(dim(`Not analyzed (${describeCode(code)}): ${listFiles(files)}`));
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Short description of the result's source for the header line. */
function sourceLabel(result: SiftResult): string {
  const { source } = result;
  if (source.kind === "range") return `${source.base}..${source.head}`;
  if (source.kind === "staged") return "--staged";
  if (source.kind === "worktree") return source.base === "HEAD" ? "working tree" : `${source.base} vs working tree`;
  return "files";
}

/** Line text lookup over the analyzed pairs. */
function createLineReader(pairs: readonly FilePair[]) {
  const cache = new Map<string, string[]>();
  return (file: string, side: Side, line: number): string | undefined => {
    const key = `${side}:${file}`;
    let lines = cache.get(key);
    if (!lines) {
      const pair = pairs.find((candidate) => (side === "old" ? candidate.oldPath : candidate.newPath) === file);
      if (!pair) return undefined;
      lines = (side === "old" ? pair.oldText : pair.newText).split("\n");
      cache.set(key, lines);
    }
    return lines[line - 1]?.replace(/\r$/, "");
  };
}

/** "3 files" / "1 file". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Up to three paths, then a count. */
function listFiles(files: string[]): string {
  if (files.length <= 3) return files.join(", ");
  return `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`;
}

/** Union of formatting kinds across files. */
function kindsOf(files: Array<{ kinds: string[] }>): string {
  return [...new Set(files.flatMap((file) => file.kinds))].sort().join(", ");
}

/** Human wording for a diagnostic code. */
function describeCode(code: string): string {
  switch (code) {
    case "unsupported-language":
      return "not TypeScript or JavaScript";
    case "parse-error":
      return "syntax the parser does not support";
    case "too-large":
      return "too large";
    default:
      return code;
  }
}
