/**
 * Labels every line git reports as changed with one category: real, comment, rename, move, or
 * format. Tokens are aligned across the whole file with an order-preserving diff, so a reorder
 * always leaves something unmatched. That alignment is trusted only when every unmatched token
 * lands on a line git reports as changed; otherwise each hunk's old and new lines are compared
 * on their own (merged when a multi-line token spans hunks).
 *
 * Moved declarations are carved out of the gaps and compared as whole units, and renamed
 * identifiers are compared under their new name. Whatever stays unmatched is real.
 */

import type { HunkRange } from "./patch";
import type { LineIndex } from "./lines";
import { lineSpan } from "./lines";
import { myersDiff } from "./myers";
import type { Token, TokenStream, FormatRule } from "./tokens";
import type { Category, RealReason, Side } from "./types";

export interface SideInput {
  text: string;
  lines: LineIndex;
  /** `null` when the file was not analyzed (unsupported, binary, parse error, too large). */
  stream: TokenStream | null;
}

/** A matched declaration pair compared on its own, outside the gaps. */
export interface MoveUnit {
  ref: string;
  /** Old-side token indices `[start, end)` in the source file of the move. */
  oldTokens: [number, number];
  /** New-side token indices `[start, end)` in the destination file of the move. */
  newTokens: [number, number];
}

/** Old-side token index → the key it has after a rename, and which rename that is. */
export type Substitutions = Map<number, { key: string; ref: string }>;

export interface LineVerdict {
  category: Category;
  ref?: string;
  reason?: RealReason;
  /** Formatting kinds observed on a format line. */
  kinds?: Set<FormatRule | "whitespace">;
}

/** Evidence collected for one line before a category is chosen. */
interface Evidence {
  real: boolean;
  reason?: RealReason;
  comment: boolean;
  rename?: string;
  move?: string;
  kinds: Set<FormatRule | "whitespace">;
}

/** Per-side evidence keyed by line number. */
export class LineLedger {
  private readonly lines = new Map<number, Evidence>();

  /** Evidence slot for a line, created on first use. */
  at(line: number): Evidence {
    let evidence = this.lines.get(line);
    if (!evidence) {
      evidence = { real: false, comment: false, kinds: new Set() };
      this.lines.set(line, evidence);
    }

    return evidence;
  }

  /** Mark lines `[from, to]` real with a reason. */
  markReal(from: number, to: number, reason: RealReason = "changed") {
    for (let line = from; line <= to; line++) {
      const evidence = this.at(line);
      evidence.real = true;
      evidence.reason ??= reason;
    }
  }

  /** Choose the category for a changed line, by precedence real > comment > rename > move > format. */
  verdict(line: number): LineVerdict {
    const evidence = this.lines.get(line);
    if (!evidence) return { category: "format", kinds: new Set(["whitespace"]) };
    if (evidence.real) return { category: "real", reason: evidence.reason ?? "changed" };
    if (evidence.comment) return { category: "comment" };
    if (evidence.rename) return { category: "rename", ref: evidence.rename };
    if (evidence.move) return { category: "move", ref: evidence.move };
    return { category: "format", kinds: evidence.kinds.size > 0 ? evidence.kinds : new Set(["whitespace"]) };
  }
}

export interface FileLedgers {
  old: LineLedger;
  new: LineLedger;
}

/** Changed line numbers on each side, from the hunk ranges. */
export function changedLines(hunks: readonly HunkRange[]): { old: number[]; new: number[] } {
  const old: number[] = [];
  const added: number[] = [];
  for (const hunk of hunks) {
    for (let index = 0; index < hunk.oldCount; index++) old.push(hunk.oldStart + index);
    for (let index = 0; index < hunk.newCount; index++) added.push(hunk.newStart + index);
  }

  return { old, new: added };
}

/** Mark every changed line of an unanalyzed file real. */
export function classifyUnanalyzed(hunks: readonly HunkRange[], reason: RealReason, ledgers: FileLedgers) {
  const lines = changedLines(hunks);
  for (const line of lines.old) ledgers.old.markReal(line, line, reason);
  for (const line of lines.new) ledgers.new.markReal(line, line, reason);
}

/**
 * Diff the gaps of one analyzed file pair, skipping tokens that belong to move units, and record
 * evidence on both sides' ledgers.
 */
export function classifyGaps(
  hunks: readonly HunkRange[],
  oldSide: SideInput,
  newSide: SideInput,
  ledgers: FileLedgers,
  options: {
    excludedOld?: Set<number>;
    excludedNew?: Set<number>;
    substitutions?: Substitutions;
    explainedOld?: Map<number, string>;
    explainedNew?: Map<number, string>;
  } = {},
) {
  const oldStream = oldSide.stream!;
  const newStream = newSide.stream!;
  const explainedOld = options.explainedOld ?? new Map<number, string>();
  const explainedNew = options.explainedNew ?? new Map<number, string>();
  const keep = (excluded: Set<number> | undefined, explained: Map<number, string>) => (index: number) =>
    !(excluded?.has(index) ?? false) && !explained.has(index);
  const keepOld = keep(options.excludedOld, explainedOld);
  const keepNew = keep(options.excludedNew, explainedNew);

  // First try one alignment over the whole file: it survives git sliding a hunk boundary (for
  // example pairing a moved function's closing brace with a neighbor's). It is used only when
  // every unmatched token sits on a line git reports as changed; otherwise fall back to
  // comparing each hunk's old and new lines on their own.
  const changed = changedLines(hunks);
  const changedOld = new Set(changed.old);
  const changedNew = new Set(changed.new);
  const whole = alignRuns(
    { side: oldSide, stream: oldStream, indices: range(0, oldStream.tokens.length).filter(keepOld), ledger: ledgers.old },
    { side: newSide, stream: newStream, indices: range(0, newStream.tokens.length).filter(keepNew), ledger: ledgers.new },
    options.substitutions,
  );

  if (whole.every((channel) => !channel.capped && unmatchedOnChangedLines(channel, changedOld, changedNew))) {
    whole.forEach((channel) => recordAlignment(channel, options.substitutions));
  } else {
    for (const gap of buildGaps(hunks, oldSide, newSide, options.excludedOld, options.excludedNew)) {
      const alignment = alignRuns(
        { side: oldSide, stream: oldStream, indices: gap.old.filter(keepOld), ledger: ledgers.old },
        { side: newSide, stream: newStream, indices: gap.new.filter(keepNew), ledger: ledgers.new },
        options.substitutions,
      );
      alignment.forEach((channel) => recordAlignment(channel, options.substitutions));
    }
  }

  recordExplained(oldSide, oldStream, ledgers.old, explainedOld);
  recordExplained(newSide, newStream, ledgers.new, explainedNew);
  recordDropped(oldSide, oldStream, ledgers.old);
  recordDropped(newSide, newStream, ledgers.new);
}

/**
 * Compare a moved declaration's old tokens with its new tokens. Unmatched code tokens are real;
 * everything else is attributed to the move. Returns whether anything inside changed.
 */
export function classifyMoveUnit(
  unit: MoveUnit,
  oldSide: SideInput,
  newSide: SideInput,
  oldLedger: LineLedger,
  newLedger: LineLedger,
  substitutions?: Substitutions,
): boolean {
  const alignment = alignRuns(
    { side: oldSide, stream: oldSide.stream!, indices: range(unit.oldTokens[0], unit.oldTokens[1]), ledger: oldLedger },
    { side: newSide, stream: newSide.stream!, indices: range(unit.newTokens[0], unit.newTokens[1]), ledger: newLedger },
    substitutions,
  );

  let changed = false;
  for (const channel of alignment) {
    changed ||= recordAlignment(channel, substitutions, unit.ref);
  }

  return changed;
}

interface Run {
  side: SideInput;
  stream: TokenStream;
  indices: number[];
  ledger: LineLedger;
}

/** One channel (code or comments) of an alignment between two runs. */
interface ChannelAlignment {
  channel: "code" | "comment";
  oldRun: Run;
  newRun: Run;
  oldIndices: number[];
  newIndices: number[];
  pairs: Array<[number, number]>;
  capped: boolean;
}

/** Align two token runs, code and comments separately, without recording anything yet. */
function alignRuns(oldRun: Run, newRun: Run, substitutions: Substitutions | undefined): ChannelAlignment[] {
  return (["code", "comment"] as const).map((channel) => {
    const pick = (run: Run) => run.indices.filter((index) => (run.stream.tokens[index]!.kind === "comment") === (channel === "comment"));
    const oldIndices = pick(oldRun);
    const newIndices = pick(newRun);
    const oldKeys = oldIndices.map((index) => substitutions?.get(index)?.key ?? oldRun.stream.tokens[index]!.key);
    const newKeys = newIndices.map((index) => newRun.stream.tokens[index]!.key);
    const { pairs, capped } = myersDiff(oldKeys, newKeys);
    return { channel, oldRun, newRun, oldIndices, newIndices, pairs, capped };
  });
}

/** True when every unmatched token touches at least one changed line on its side. */
function unmatchedOnChangedLines(alignment: ChannelAlignment, changedOld: Set<number>, changedNew: Set<number>): boolean {
  const matchedOld = new Set(alignment.pairs.map(([i]) => i));
  const matchedNew = new Set(alignment.pairs.map(([, j]) => j));
  const touches = (run: Run, index: number, changed: Set<number>) => tokenLines(run.side, run.stream.tokens[index]!).some((line) => changed.has(line));

  return (
    alignment.oldIndices.every((index, i) => matchedOld.has(i) || touches(alignment.oldRun, index, changedOld)) &&
    alignment.newIndices.every((index, j) => matchedNew.has(j) || touches(alignment.newRun, index, changedNew))
  );
}

/**
 * Write evidence for an alignment: matched tokens may carry a rename or a move, unmatched code
 * is real, unmatched comments are comment edits. Returns whether any code token was unmatched.
 */
function recordAlignment(alignment: ChannelAlignment, substitutions: Substitutions | undefined, moveRef?: string): boolean {
  const { oldRun, newRun, oldIndices, newIndices, pairs, capped } = alignment;
  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();

  for (const [i, j] of pairs) {
    matchedOld.add(i);
    matchedNew.add(j);
    const oldToken = oldRun.stream.tokens[oldIndices[i]!]!;
    const newToken = newRun.stream.tokens[newIndices[j]!]!;
    const rename = substitutions?.get(oldIndices[i]!)?.ref;
    noteMatched(oldRun, oldToken, rename, moveRef);
    noteMatched(newRun, newToken, rename, moveRef);
    if (!rename && oldToken.raw !== newToken.raw) {
      const kind = literalKind(oldToken);
      if (kind) {
        for (const line of tokenLines(oldRun.side, oldToken)) oldRun.ledger.at(line).kinds.add(kind);
        for (const line of tokenLines(newRun.side, newToken)) newRun.ledger.at(line).kinds.add(kind);
      }
    }
  }

  const reason: RealReason = capped ? "diff-too-large" : "changed";
  let changed = false;
  oldIndices.forEach((index, i) => {
    if (matchedOld.has(i)) return;
    changed ||= alignment.channel === "code";
    noteUnmatched(oldRun, oldRun.stream.tokens[index]!, reason);
  });
  newIndices.forEach((index, j) => {
    if (matchedNew.has(j)) return;
    changed ||= alignment.channel === "code";
    noteUnmatched(newRun, newRun.stream.tokens[index]!, reason);
  });

  return changed;
}

/** Attribute tokens a move accounts for (import updates, an added `export`) to that move. */
function recordExplained(side: SideInput, stream: TokenStream, ledger: LineLedger, explained: Map<number, string>) {
  for (const [index, ref] of explained) {
    for (const line of tokenLines(side, stream.tokens[index]!)) ledger.at(line).move ??= ref;
  }
}

/** Record that a token survived the comparison. */
function noteMatched(run: Run, token: Token, rename: string | undefined, moveRef: string | undefined) {
  for (const line of tokenLines(run.side, token)) {
    const evidence = run.ledger.at(line);
    if (rename) evidence.rename ??= rename;
    if (moveRef) evidence.move ??= moveRef;
  }
}

/** Record a token with no counterpart: real for code, a comment edit for comments. */
function noteUnmatched(run: Run, token: Token, reason: RealReason) {
  for (const line of tokenLines(run.side, token)) {
    if (token.kind === "comment") {
      run.ledger.at(line).comment = true;
    } else {
      run.ledger.markReal(line, line, reason);
    }
  }
}

/** Formatting kind implied by a matched token whose source text changed. */
function literalKind(token: Token): FormatRule | null {
  const norm = token.key.split("\u0001")[1] ?? "";
  if (norm.startsWith("S:") || norm.startsWith("R:")) return "quotes";
  if (norm.startsWith("N:")) return "numbers";
  if (norm.startsWith("K:")) return "key-quotes";
  if (norm.startsWith("X:")) return "jsx-whitespace";
  return null;
}

/** Lines a token occupies. */
function tokenLines(side: SideInput, token: Token): number[] {
  const [first, last] = lineSpan(side.lines, token.start, token.end);
  return range(first, last + 1);
}

/** Note the formatting rule of each dropped punctuation token on its line. */
function recordDropped(side: SideInput, stream: TokenStream, ledger: LineLedger) {
  for (const dropped of stream.dropped) {
    const [first, last] = lineSpan(side.lines, dropped.start, dropped.end);
    for (let line = first; line <= last; line++) ledger.at(line).kinds.add(dropped.rule);
  }
}

export interface Gap {
  old: number[];
  new: number[];
}

/**
 * Group token indices by hunk on each side. A token belongs to a hunk when any of its lines is
 * a changed line of that hunk; hunks that share a token are merged into one gap.
 */
export function buildGaps(
  hunks: readonly HunkRange[],
  oldSide: SideInput,
  newSide: SideInput,
  excludedOld: Set<number> = new Set(),
  excludedNew: Set<number> = new Set(),
): Gap[] {
  const parent = hunks.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };

  const assign = (side: SideInput, excluded: Set<number>, rangeOf: (hunk: HunkRange) => [number, number]) => {
    const owners = new Map<number, number[]>();
    side.stream!.tokens.forEach((token, index) => {
      if (excluded.has(index)) return;
      const [first, last] = lineSpan(side.lines, token.start, token.end);
      const hits: number[] = [];
      hunks.forEach((hunk, hunkIndex) => {
        const [start, end] = rangeOf(hunk);
        if (start <= end && first <= end && last >= start) hits.push(hunkIndex);
      });
      if (hits.length === 0) return;
      for (const hit of hits.slice(1)) union(hits[0]!, hit);
      owners.set(index, hits);
    });
    return owners;
  };

  const oldOwners = assign(oldSide, excludedOld, (hunk) => [hunk.oldStart, hunk.oldStart + hunk.oldCount - 1]);
  const newOwners = assign(newSide, excludedNew, (hunk) => [hunk.newStart, hunk.newStart + hunk.newCount - 1]);

  const gaps = new Map<number, Gap>();
  const gapOf = (hunkIndex: number) => {
    const root = find(hunkIndex);
    let gap = gaps.get(root);
    if (!gap) {
      gap = { old: [], new: [] };
      gaps.set(root, gap);
    }
    return gap;
  };

  for (const [index, hits] of oldOwners) gapOf(hits[0]!).old.push(index);
  for (const [index, hits] of newOwners) gapOf(hits[0]!).new.push(index);

  return [...gaps.entries()].sort(([a], [b]) => a - b).map(([, gap]) => gap);
}

/** Integers in `[start, end)`. */
function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

export type { Side };
