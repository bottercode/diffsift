/**
 * Runs the whole analysis over a set of file pairs: tokenize every supported file, find moved
 * declarations and consistent renames across all files, classify each changed line, and build
 * the schema v1 result.
 *
 * Moves and renames are discovered across the whole change set because agents move code between
 * files; line classification then happens per file. Anything that cannot be proven mechanical
 * stays real, and the result is sorted so identical inputs give byte-identical output.
 */

import { classifyGaps, classifyMoveUnit, classifyUnanalyzed, changedLines, LineLedger, type FileLedgers, type SideInput } from "./classify";
import { extractDeclarations } from "./declarations";
import { grammarFor, type Grammar } from "./languages";
import { indexLines, lineHunks } from "./lines";
import { matchDeclarations } from "./match";
import type { ParserHost } from "./parser";
import { findRenames } from "./renames";
import { buildResult, type AnalyzedFile } from "./summary";
import { tokenize } from "./tokens";
import type { FilePair, RealReason, SiftResult } from "./types";

export interface SiftOptions {
  source?: SiftResult["source"];
  /** Files larger than this are not analyzed (all their changed lines are real). Default 1 MB. */
  maxFileBytes?: number;
  /** Paths of unchanged files that still mention a name, for the rename stale-reference guard. */
  staleReferences?: (name: string) => Promise<string[]> | string[];
  version?: string;
}

/** Analyze file pairs and return the schema v1 result. */
export async function sift(pairs: readonly FilePair[], host: ParserHost, options: SiftOptions = {}): Promise<SiftResult> {
  const maxBytes = options.maxFileBytes ?? 1_000_000;
  const files: AnalyzedFile[] = [];
  const parsedToDispose: Array<ReturnType<ParserHost["parse"]>> = [];

  try {
    for (const pair of [...pairs].sort(comparePairs)) {
      files.push(prepareFile(pair, host, maxBytes, parsedToDispose));
    }

    for (const file of files) {
      if (file.analyzed) {
        file.oldDeclarations = extractDeclarations(file.oldParsed!, file.old.stream!, file.oldPath ?? "");
        file.newDeclarations = extractDeclarations(file.newParsed!, file.new.stream!, file.newPath ?? "");
      }
    }

    const renames = await findRenames(files, { staleReferences: options.staleReferences, filesMode: options.source?.kind === "files" });
    const moves = matchDeclarations(files, renames);

    for (const file of files) {
      if (!file.analyzed) {
        classifyUnanalyzed(file.hunks, file.reason!, file.ledgers);
        continue;
      }

      classifyGaps(file.hunks, file.old, file.new, file.ledgers, {
        excludedOld: moves.excludedOld.get(file) ?? new Set(),
        excludedNew: moves.excludedNew.get(file) ?? new Set(),
        substitutions: renames.substitutions.get(file),
        explainedOld: moves.explainedOld.get(file),
        explainedNew: moves.explainedNew.get(file),
      });
    }

    for (const move of moves.units) {
      move.changedInside = classifyMoveUnit(
        move.unit,
        move.oldFile.old,
        move.newFile.new,
        move.oldFile.ledgers.old,
        move.newFile.ledgers.new,
        renames.substitutions.get(move.oldFile),
      );
    }

    return buildResult(files, renames, moves, options);
  } finally {
    for (const parsed of parsedToDispose) host.dispose(parsed);
  }
}

/** Order pairs by their new path (or old path for deletions), byte-wise. */
function comparePairs(a: FilePair, b: FilePair) {
  const keyA = a.newPath ?? a.oldPath ?? "";
  const keyB = b.newPath ?? b.oldPath ?? "";
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/** Parse and tokenize one pair, or record why it cannot be analyzed. */
function prepareFile(pair: FilePair, host: ParserHost, maxBytes: number, toDispose: Array<ReturnType<ParserHost["parse"]>>): AnalyzedFile {
  const hunks = pair.hunks ?? lineHunks(pair.oldText, pair.newText);
  const ledgers: FileLedgers = { old: new LineLedger(), new: new LineLedger() };
  const grammar = grammarFor(pair.newPath ?? pair.oldPath ?? "");
  const old: SideInput = { text: pair.oldText, lines: indexLines(pair.oldText), stream: null };
  const added: SideInput = { text: pair.newText, lines: indexLines(pair.newText), stream: null };
  const base: AnalyzedFile = {
    oldPath: pair.oldPath,
    newPath: pair.newPath,
    status: pair.status,
    similarity: pair.similarity,
    grammar,
    hunks,
    old,
    new: added,
    ledgers,
    analyzed: false,
  };

  const reason = unanalyzableReason(pair, grammar, maxBytes);
  if (reason) {
    return { ...base, reason };
  }

  const oldParsed = host.parse(grammar!, pair.oldText);
  const newParsed = host.parse(grammar!, pair.newText);
  toDispose.push(oldParsed, newParsed);
  if (!oldParsed.ok || !newParsed.ok) {
    return { ...base, reason: "parse-error" };
  }

  old.stream = tokenize(oldParsed.tree, pair.oldText, grammar!);
  added.stream = tokenize(newParsed.tree, pair.newText, grammar!);
  return { ...base, analyzed: true, oldParsed, newParsed };
}

/** Why a pair is not analyzed, or `null` when it can be. */
function unanalyzableReason(pair: FilePair, grammar: Grammar | null, maxBytes: number): RealReason | null {
  if (pair.binary) return "binary";
  if (grammar === null) return "unsupported-language";
  if (pair.oldText.length > maxBytes || pair.newText.length > maxBytes) return "too-large";
  return null;
}

export { changedLines };
