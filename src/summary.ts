/**
 * Builds the schema v1 result from classified files: per-line entries, grouped real changes,
 * renames, moves, formatting summaries, and totals. All lists are explicitly sorted and ids are
 * assigned after sorting, so the output never depends on discovery order.
 *
 * A real edit inside a moved declaration is reported once, on the new side, with the old line
 * attached, so "changed while moving" counts as one real change rather than a deletion plus an
 * insertion in two files.
 */

import type { FileLedgers, LineVerdict, SideInput } from "./classify";
import type { Decl } from "./declarations";
import type { Grammar } from "./languages";
import { lineAt, splitLines } from "./lines";
import type { MoveRecord, MoveResult } from "./match";
import type { ParsedFile } from "./parser";
import type { HunkRange } from "./patch";
import type { RenameResult } from "./renames";
import type { SiftOptions } from "./sift";
import type { Category, Diagnostic, FileResult, FileStatus, FormatFile, FormatKind, LineEntry, Move, RealChange, RealReason, Rename, Side, SiftResult } from "./types";
import { VERSION } from "./version";

export interface AnalyzedFile {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  similarity?: number;
  grammar: Grammar | null;
  hunks: HunkRange[];
  old: SideInput;
  new: SideInput;
  ledgers: FileLedgers;
  analyzed: boolean;
  reason?: RealReason;
  oldParsed?: ParsedFile;
  newParsed?: ParsedFile;
  oldDeclarations?: Decl[];
  newDeclarations?: Decl[];
}

/** Assemble the final result. */
export function buildResult(files: AnalyzedFile[], renames: RenameResult, moves: MoveResult, options: SiftOptions): SiftResult {
  const verdicts = new Map<AnalyzedFile, { old: Map<number, LineVerdict>; new: Map<number, LineVerdict> }>();
  for (const file of files) {
    verdicts.set(file, collectVerdicts(file));
  }

  const moveIds = assignMoveIds(moves.units);
  const renameIds = new Map(renames.groups.map((group, index) => [group, `r${index + 1}`]));

  const fileResults = files.map((file) => toFileResult(file, verdicts.get(file)!, moveIds, renames));
  const realChanges = collectRealChanges(files, verdicts, moves.units, moveIds);
  const byCategory: Record<Category, number> = { format: 0, comment: 0, rename: 0, move: 0, real: 0 };
  let analyzedLines = 0;
  let mechanical = 0;

  for (const file of fileResults) {
    for (const entry of file.lines) {
      byCategory[entry.category] += 1;
      if (file.analyzed && entry.category !== "comment") {
        analyzedLines += 1;
        if (entry.category !== "real") mechanical += 1;
      }
    }
  }

  // Count real lines, not spans: blank lines bridged inside a change are not real.
  const realLines = realChanges.reduce((total, change) => {
    const file = files.find((candidate) => (change.side === "old" ? candidate.oldPath : candidate.newPath) === change.file);
    const sideVerdicts = file ? verdicts.get(file)![change.side] : undefined;
    let count = 0;
    for (let line = change.line; line <= change.endLine; line++) {
      if (!sideVerdicts || sideVerdicts.get(line)?.category === "real") count += 1;
    }
    return total + count;
  }, 0);
  const changedLines = fileResults.reduce((total, file) => total + file.lines.length, 0);

  return {
    schemaVersion: 1,
    tool: { name: "diffsift", version: options.version ?? VERSION },
    source: options.source ?? { kind: "files", diffAlgorithm: "myers" },
    summary: {
      files: files.length,
      changedLines,
      byCategory,
      mechanicalRatio: analyzedLines === 0 ? 0 : Math.round((mechanical / analyzedLines) * 10_000) / 10_000,
      realLines,
    },
    renames: renames.groups.map((group) => ({ ...group.report, id: renameIds.get(group)! })),
    moves: moves.units
      .map((record) => toMove(record, moveIds.get(record)!, verdicts))
      .sort((a, b) => compareStrings(a.id, b.id)),
    fileMoves: files
      .filter((file) => file.status === "renamed" && file.similarity === 100 && file.oldPath && file.newPath)
      .map((file) => ({ from: file.oldPath!, to: file.newPath! })),
    formatFiles: collectFormatFiles(files, verdicts),
    realChanges,
    files: fileResults,
    diagnostics: collectDiagnostics(files),
  };
}

/** Verdict for every changed line on both sides of a file. */
function collectVerdicts(file: AnalyzedFile) {
  const old = new Map<number, LineVerdict>();
  const added = new Map<number, LineVerdict>();
  for (const hunk of file.hunks) {
    for (let index = 0; index < hunk.oldCount; index++) {
      const line = hunk.oldStart + index;
      old.set(line, file.ledgers.old.verdict(line));
    }
    for (let index = 0; index < hunk.newCount; index++) {
      const line = hunk.newStart + index;
      added.set(line, file.ledgers.new.verdict(line));
    }
  }

  return { old, new: added };
}

/** Number moves `m1…` in order of symbol, then source file, then line. */
function assignMoveIds(units: MoveRecord[]) {
  const sorted = [...units].sort(
    (a, b) =>
      compareStrings(a.symbol, b.symbol) ||
      compareStrings(a.oldFile.oldPath ?? "", b.oldFile.oldPath ?? "") ||
      a.oldDecl.startLine - b.oldDecl.startLine,
  );
  return new Map(sorted.map((record, index) => [record, `m${index + 1}`]));
}

/** Per-file entry with sorted line verdicts. */
function toFileResult(
  file: AnalyzedFile,
  verdicts: { old: Map<number, LineVerdict>; new: Map<number, LineVerdict> },
  moveIds: Map<MoveRecord, string>,
  renames: RenameResult,
): FileResult {
  const refFor = (verdict: LineVerdict) => resolveRef(verdict.ref, moveIds, renames);
  const lines: LineEntry[] = [];

  for (const side of ["old", "new"] as const) {
    for (const [line, verdict] of [...verdicts[side].entries()].sort(([a], [b]) => a - b)) {
      const entry: LineEntry = { side, line, category: verdict.category };
      const ref = refFor(verdict);
      if (ref) entry.ref = ref;
      if (verdict.reason && verdict.category === "real") entry.reason = verdict.reason;
      lines.push(entry);
    }
  }

  const changed = lines.length;
  return {
    oldPath: file.oldPath,
    newPath: file.newPath,
    status: file.status,
    ...(file.similarity === undefined ? {} : { similarity: file.similarity }),
    language: file.grammar,
    analyzed: file.analyzed,
    formatOnly: file.analyzed && changed > 0 && lines.every((entry) => entry.category === "format"),
    hunks: file.hunks.map((hunk) => hunk.header),
    lines,
  };
}

/** Internal refs are object identities until ids are assigned; map them to `r1`/`m1`. */
function resolveRef(ref: string | undefined, moveIds: Map<MoveRecord, string>, renames: RenameResult): string | undefined {
  if (!ref) return undefined;
  for (const [record, id] of moveIds) {
    if (record.ref === ref) return id;
  }

  const index = renames.groups.findIndex((group) => group.ref === ref);
  return index === -1 ? undefined : `r${index + 1}`;
}

/** Schema form of a move, with the lines that changed inside it. */
function toMove(record: MoveRecord, id: string, verdicts: Map<AnalyzedFile, { old: Map<number, LineVerdict>; new: Map<number, LineVerdict> }>): Move {
  const changedLines: Move["changedLines"] = [];
  const fromFile = record.oldFile.oldPath ?? "";
  const toFile = record.newFile.newPath ?? "";

  for (let line = record.oldDecl.startLine; line <= record.oldDecl.endLine; line++) {
    if (verdicts.get(record.oldFile)!.old.get(line)?.category === "real") changedLines.push({ side: "old", file: fromFile, line });
  }
  for (let line = record.newDecl.startLine; line <= record.newDecl.endLine; line++) {
    if (verdicts.get(record.newFile)!.new.get(line)?.category === "real") changedLines.push({ side: "new", file: toFile, line });
  }

  return {
    id,
    symbol: record.symbol,
    kind: record.kind,
    from: { file: fromFile, startLine: record.oldDecl.startLine, endLine: record.oldDecl.endLine },
    to: { file: toFile, startLine: record.newDecl.startLine, endLine: record.newDecl.endLine },
    ...(record.renamedFrom ? { renamedFrom: record.renamedFrom } : {}),
    ...(record.exportAdded ? { exportAdded: true } : {}),
    changedInside: changedLines.length > 0,
    changedLines,
  };
}

/** Group real lines into changes: per hunk, plus one entry per moved declaration edited in place. */
function collectRealChanges(
  files: AnalyzedFile[],
  verdicts: Map<AnalyzedFile, { old: Map<number, LineVerdict>; new: Map<number, LineVerdict> }>,
  moves: MoveRecord[],
  moveIds: Map<MoveRecord, string>,
): RealChange[] {
  const changes: RealChange[] = [];
  const claimed = new Map<AnalyzedFile, { old: Set<number>; new: Set<number> }>();
  const claim = (file: AnalyzedFile, side: Side, line: number) => {
    let entry = claimed.get(file);
    if (!entry) {
      entry = { old: new Set(), new: new Set() };
      claimed.set(file, entry);
    }
    entry[side].add(line);
  };

  for (const record of moves) {
    const oldReal = linesIn(verdicts.get(record.oldFile)!.old, record.oldDecl.startLine, record.oldDecl.endLine, "real");
    const newReal = linesIn(verdicts.get(record.newFile)!.new, record.newDecl.startLine, record.newDecl.endLine, "real");
    oldReal.forEach((line) => claim(record.oldFile, "old", line));
    newReal.forEach((line) => claim(record.newFile, "new", line));
    const symbol = record.symbol;

    if (newReal.length > 0) {
      for (const [line, endLine] of runs(newReal)) {
        changes.push({
          file: record.newFile.newPath ?? "",
          side: "new",
          line,
          endLine,
          ...(oldReal.length > 0 ? { oldLine: oldReal[0]!, oldEndLine: oldReal.at(-1)! } : {}),
          ...(oldReal.length > 0 && record.oldFile !== record.newFile ? { oldFile: record.oldFile.oldPath ?? "" } : {}),
          reason: "changed",
          symbol,
        });
      }
    } else {
      for (const [line, endLine] of runs(oldReal)) {
        changes.push({ file: record.oldFile.oldPath ?? "", side: "old", line, endLine, reason: "changed", symbol });
      }
    }

    void moveIds;
  }

  for (const file of files) {
    const fileVerdicts = verdicts.get(file)!;
    const taken = claimed.get(file);
    for (const hunk of file.hunks) {
      const reasonOf = (side: Side, line: number) => fileVerdicts[side].get(line)?.reason ?? "changed";
      const oldReal = linesIn(fileVerdicts.old, hunk.oldStart, hunk.oldStart + hunk.oldCount - 1, "real").filter((line) => !taken?.old.has(line));
      const newReal = linesIn(fileVerdicts.new, hunk.newStart, hunk.newStart + hunk.newCount - 1, "real").filter((line) => !taken?.new.has(line));

      if (newReal.length > 0) {
        for (const [line, endLine] of runs(newReal, isBlank(file.new.text))) {
          changes.push({
            file: file.newPath ?? file.oldPath ?? "",
            side: "new",
            line,
            endLine,
            ...(oldReal.length > 0 ? { oldLine: oldReal[0]!, oldEndLine: oldReal.at(-1)! } : {}),
            reason: reasonOf("new", line),
            ...symbolAt(file.newDeclarations, line),
          });
        }
      } else {
        for (const [line, endLine] of runs(oldReal, isBlank(file.old.text))) {
          changes.push({
            file: file.oldPath ?? file.newPath ?? "",
            side: "old",
            line,
            endLine,
            reason: reasonOf("old", line),
            ...symbolAt(file.oldDeclarations, line),
          });
        }
      }
    }
  }

  return changes.sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.side, b.side) || a.line - b.line);
}

/** Innermost declaration containing a line, as `{ symbol }`. */
function symbolAt(declarations: Decl[] | undefined, line: number): { symbol?: string } {
  const containing = (declarations ?? []).filter((decl) => decl.startLine <= line && line <= decl.endLine);
  if (containing.length === 0) return {};
  const innermost = containing.reduce((best, decl) => (decl.endLine - decl.startLine < best.endLine - best.startLine ? decl : best));
  return { symbol: innermost.qualifiedName };
}

/** Changed lines in `[from, to]` with a category. */
function linesIn(verdicts: Map<number, LineVerdict>, from: number, to: number, category: Category): number[] {
  const lines: number[] = [];
  for (let line = from; line <= to; line++) {
    if (verdicts.get(line)?.category === category) lines.push(line);
  }

  return lines;
}

/**
 * Collapse sorted line numbers into inclusive runs. With `bridge`, runs separated only by lines
 * it accepts (blank lines) are joined, so one added block reads as one change.
 */
function runs(lines: number[], bridge: (line: number) => boolean = () => false): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (const line of lines) {
    const last = result.at(-1);
    let joinable = last !== undefined;
    for (let between = (last?.[1] ?? 0) + 1; joinable && between < line; between++) {
      joinable = bridge(between);
    }

    if (last && joinable) {
      last[1] = line;
    } else {
      result.push([line, line]);
    }
  }

  return result;
}

/** Predicate for blank lines of a text (one-based). */
function isBlank(text: string): (line: number) => boolean {
  const lines = splitLines(text);
  return (line) => (lines[line - 1] ?? "").trim() === "";
}

/** Files with formatting lines, with the kinds of formatting seen. */
function collectFormatFiles(files: AnalyzedFile[], verdicts: Map<AnalyzedFile, { old: Map<number, LineVerdict>; new: Map<number, LineVerdict> }>): FormatFile[] {
  const result: FormatFile[] = [];
  for (const file of files) {
    if (!file.analyzed) continue;
    const fileVerdicts = verdicts.get(file)!;
    const all = [...fileVerdicts.old.values(), ...fileVerdicts.new.values()];
    const format = all.filter((verdict) => verdict.category === "format");
    if (format.length === 0) continue;

    // Literal rewrites (quotes, numbers, key quotes, JSX text) are recorded per line. Dropped
    // punctuation counts only when the changed lines of the two sides differ in how much of it
    // they have, so unchanged semicolons on a reformatted line are not reported as a change.
    const kinds = new Set<FormatKind>();
    const oldLines = splitLines(file.old.text);
    const newLines = splitLines(file.new.text);
    const droppedCounts = (side: "old" | "new") => {
      const counts = new Map<FormatKind, number>();
      const sideInput = side === "old" ? file.old : file.new;
      const changed = side === "old" ? fileVerdicts.old : fileVerdicts.new;
      for (const dropped of sideInput.stream!.dropped) {
        const line = lineAt(sideInput.lines, dropped.start);
        if (changed.get(line)?.category === "format") counts.set(dropped.rule, (counts.get(dropped.rule) ?? 0) + 1);
      }
      return counts;
    };
    const oldDropped = droppedCounts("old");
    const newDropped = droppedCounts("new");
    for (const rule of new Set([...oldDropped.keys(), ...newDropped.keys()])) {
      if ((oldDropped.get(rule) ?? 0) !== (newDropped.get(rule) ?? 0)) kinds.add(rule);
    }

    for (const [side, sideVerdicts] of [["old", fileVerdicts.old], ["new", fileVerdicts.new]] as const) {
      for (const [line, verdict] of sideVerdicts) {
        if (verdict.category !== "format") continue;
        const ruled = [...(verdict.kinds ?? [])].filter((kind) => kind !== "whitespace");
        ruled.forEach((kind) => kinds.add(kind));
        const text = side === "old" ? oldLines[line - 1] : newLines[line - 1];
        if ((text ?? "").endsWith("\r") !== ((side === "old" ? newLines : oldLines)[line - 1] ?? "").endsWith("\r")) kinds.add("line-endings");
      }
    }

    // Lines that differ only in whitespace: present when some format line is explained by
    // nothing above (indentation, wrapping, blank lines).
    const explained = kinds.size > 0;
    for (const [side, sideVerdicts] of [["old", fileVerdicts.old], ["new", fileVerdicts.new]] as const) {
      for (const [line, verdict] of sideVerdicts) {
        if (verdict.category !== "format") continue;
        const text = (side === "old" ? oldLines : newLines)[line - 1] ?? "";
        const ruled = [...(verdict.kinds ?? [])].filter((kind) => kind !== "whitespace");
        if (ruled.length === 0 && (text.trim() === "" || !explained)) kinds.add("whitespace");
      }
    }
    result.push({
      file: file.newPath ?? file.oldPath ?? "",
      lines: format.length,
      kinds: [...kinds].sort(),
      formatOnly: format.length === all.length,
    });
  }

  return result;
}

/** One diagnostic per file that was not analyzed. */
function collectDiagnostics(files: AnalyzedFile[]): Diagnostic[] {
  return files
    .filter((file) => !file.analyzed && file.hunks.length > 0)
    .map((file) => ({
      file: file.newPath ?? file.oldPath ?? "",
      code: file.reason ?? "unparsed",
      message: diagnosticMessage(file.reason),
    }));
}

/** Human explanation for a skipped file. */
function diagnosticMessage(reason: RealReason | undefined): string {
  switch (reason) {
    case "parse-error":
      return "Syntax errors; every changed line is reported as real.";
    case "unsupported-language":
      return "Not a TypeScript or JavaScript file; every changed line is reported as real.";
    case "binary":
      return "Binary file.";
    case "too-large":
      return "File is larger than the analysis limit; every changed line is reported as real.";
    default:
      return "Not analyzed; every changed line is reported as real.";
  }
}

/** Byte-wise string comparison that never depends on locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type { Rename };
