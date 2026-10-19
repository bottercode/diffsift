/**
 * Pairs declarations that moved, within a file or to another file, and marks the import updates
 * that only exist because of a move.
 *
 * A move is accepted only for declarations whose position cannot change behavior: hoisted ones
 * (functions, types, methods) may be reordered within a file; classes and constants with
 * side-effect-free initializers may additionally move to another file. A pair needs the same
 * name, unique on both sides, and either identical tokens or at least half of its tokens in
 * common (then it is "changed while moving" and the differing lines are real).
 */

import type { MoveUnit } from "./classify";
import type { Decl } from "./declarations";
import { resolveModule } from "./imports";
import { myersDiff } from "./myers";
import type { RenameResult } from "./renames";
import type { AnalyzedFile } from "./summary";

export interface MoveRecord {
  ref: string;
  symbol: string;
  kind: string;
  oldFile: AnalyzedFile;
  newFile: AnalyzedFile;
  oldDecl: Decl;
  newDecl: Decl;
  unit: MoveUnit;
  changedInside: boolean;
  renamedFrom?: string;
  exportAdded?: boolean;
}

export interface MoveResult {
  units: MoveRecord[];
  excludedOld: Map<AnalyzedFile, Set<number>>;
  excludedNew: Map<AnalyzedFile, Set<number>>;
  /** Token indices explained by a move (import updates, an added `export`), per file side. */
  explainedOld: Map<AnalyzedFile, Map<number, string>>;
  explainedNew: Map<AnalyzedFile, Map<number, string>>;
}

const MIN_SIMILARITY = 0.5;

/** Find moved declarations across the change set. */
export function matchDeclarations(files: AnalyzedFile[], renames: RenameResult): MoveResult {
  const result: MoveResult = { units: [], excludedOld: new Map(), excludedNew: new Map(), explainedOld: new Map(), explainedNew: new Map() };
  const analyzed = files.filter((file) => file.analyzed);

  // Declarations whose token ranges git reports as changed, so moved code is actually in a gap.
  const vanished: Array<{ file: AnalyzedFile; decl: Decl }> = [];
  const appeared: Array<{ file: AnalyzedFile; decl: Decl }> = [];

  for (const file of analyzed) {
    const oldDecls = topLevelOrMember(file.oldDeclarations ?? []);
    const newDecls = topLevelOrMember(file.newDeclarations ?? []);
    const oldByName = groupBy(oldDecls, (decl) => decl.qualifiedName);
    const newByName = groupBy(newDecls, (decl) => decl.qualifiedName);

    for (const decl of oldDecls) {
      const sameName = newByName.get(decl.qualifiedName) ?? [];
      if (sameName.length === 0 && touchesChange(file, "old", decl)) vanished.push({ file, decl });
    }
    for (const decl of newDecls) {
      const sameName = oldByName.get(decl.qualifiedName) ?? [];
      if (sameName.length === 0 && touchesChange(file, "new", decl)) appeared.push({ file, decl });
    }

    matchWithinFile(file, oldDecls, newDecls, oldByName, newByName, renames, result);
  }

  matchAcrossFiles(vanished, appeared, renames, result);
  explainImportUpdates(files, result);
  return result;
}

/** Module-level declarations and members of module-level classes. */
function topLevelOrMember(decls: Decl[]): Decl[] {
  return decls.filter((decl) => decl.topLevel);
}

/** Whether any line of a declaration is a changed line on that side. */
function touchesChange(file: AnalyzedFile, side: "old" | "new", decl: Decl): boolean {
  return file.hunks.some((hunk) => {
    const start = side === "old" ? hunk.oldStart : hunk.newStart;
    const count = side === "old" ? hunk.oldCount : hunk.newCount;
    return count > 0 && decl.startLine <= start + count - 1 && decl.endLine >= start;
  });
}

/**
 * Same-file reorders: pair same-named declarations, keep the longest run that stayed in order,
 * and treat the rest as moved when git saw both their old and new lines as changed.
 */
function matchWithinFile(
  file: AnalyzedFile,
  oldDecls: Decl[],
  newDecls: Decl[],
  oldByName: Map<string, Decl[]>,
  newByName: Map<string, Decl[]>,
  renames: RenameResult,
  result: MoveResult,
) {
  const pairs: Array<[Decl, Decl]> = [];
  for (const decl of oldDecls) {
    const olds = oldByName.get(decl.qualifiedName)!;
    const news = newByName.get(decl.qualifiedName) ?? [];
    if (olds.length === 1 && news.length === 1) pairs.push([decl, news[0]!]);
  }

  // Pairs are in old order; the longest increasing run of new positions stayed put.
  const order = pairs.map(([, newDecl]) => String(newDecl.tokens[0]).padStart(12, "0"));
  const sorted = [...order].sort();
  const { pairs: kept } = myersDiff(order, sorted);
  const stayed = new Set(kept.map(([i]) => i));

  pairs.forEach(([oldDecl, newDecl], index) => {
    if (stayed.has(index)) return;
    if (!oldDecl.hoisted || !newDecl.hoisted) return;
    if (!touchesChange(file, "old", oldDecl) || !touchesChange(file, "new", newDecl)) return;
    if (similarity(file, file, oldDecl, newDecl, renames) < MIN_SIMILARITY) return;
    addMove(result, file, file, oldDecl, newDecl);
  });
}

/** Cross-file moves: a declaration vanished from one file and a same-named one appeared in another. */
function matchAcrossFiles(
  vanished: Array<{ file: AnalyzedFile; decl: Decl }>,
  appeared: Array<{ file: AnalyzedFile; decl: Decl }>,
  renames: RenameResult,
  result: MoveResult,
) {
  const vanishedByName = groupBy(vanished, (entry) => entry.decl.qualifiedName);
  const appearedByName = groupBy(appeared, (entry) => entry.decl.qualifiedName);

  for (const [name, sources] of vanishedByName) {
    const targets = appearedByName.get(name) ?? [];
    if (sources.length !== 1 || targets.length !== 1) continue;
    const source = sources[0]!;
    const target = targets[0]!;
    if (source.file === target.file) continue;
    if (!source.decl.orderInsensitive || !target.decl.orderInsensitive) continue;
    if (source.decl.kind !== target.decl.kind) continue;
    if (similarity(source.file, target.file, source.decl, target.decl, renames) < MIN_SIMILARITY) continue;
    addMove(result, source.file, target.file, source.decl, target.decl);
  }
}

/** Fraction of the larger declaration's tokens that line up (after applying renames). */
function similarity(oldFile: AnalyzedFile, newFile: AnalyzedFile, oldDecl: Decl, newDecl: Decl, renames: RenameResult): number {
  const substitutions = renames.substitutions.get(oldFile);
  const oldKeys: string[] = [];
  for (let index = oldDecl.tokens[0]; index < oldDecl.tokens[1]; index++) {
    const token = oldFile.old.stream!.tokens[index]!;
    if (token.kind !== "comment") oldKeys.push(substitutions?.get(index)?.key ?? token.key);
  }

  const newKeys = newFile.new.stream!.tokens
    .slice(newDecl.tokens[0], newDecl.tokens[1])
    .filter((token) => token.kind !== "comment")
    .map((token) => token.key);
  const { pairs } = myersDiff(oldKeys, newKeys);
  return pairs.length / Math.max(oldKeys.length, newKeys.length, 1);
}

/** Record a move and carve its tokens out of both files' gaps. */
function addMove(result: MoveResult, oldFile: AnalyzedFile, newFile: AnalyzedFile, oldDecl: Decl, newDecl: Decl) {
  const ref = `move:${oldFile.oldPath}:${oldDecl.qualifiedName}:${oldDecl.tokens[0]}`;
  const exportAdded = !oldDecl.exported && newDecl.exported && newDecl.exportToken !== undefined;
  const newStart = exportAdded ? newDecl.exportToken! + 1 : newDecl.tokens[0];

  result.units.push({
    ref,
    symbol: oldDecl.qualifiedName,
    kind: oldDecl.kind,
    oldFile,
    newFile,
    oldDecl,
    newDecl,
    unit: { ref, oldTokens: oldDecl.tokens, newTokens: [newStart, newDecl.tokens[1]] },
    changedInside: false,
    ...(exportAdded ? { exportAdded: true } : {}),
  });

  const excludedOld = setFor(result.excludedOld, oldFile);
  for (let index = oldDecl.tokens[0]; index < oldDecl.tokens[1]; index++) excludedOld.add(index);
  const excludedNew = setFor(result.excludedNew, newFile);
  for (let index = newDecl.tokens[0]; index < newDecl.tokens[1]; index++) excludedNew.add(index);

  if (exportAdded) {
    mapFor(result.explainedNew, newFile).set(newDecl.exportToken!, ref);
  }
}

/**
 * Mark import specifiers (and whole import statements) that changed only because their symbol
 * moved: `import { isExpired } from "./utils"` becoming `import { isExpired } from "./auth/session"`.
 */
function explainImportUpdates(files: AnalyzedFile[], result: MoveResult) {
  const crossFile = result.units.filter((move) => move.oldFile !== move.newFile);
  if (crossFile.length === 0) return;

  const oldPaths = new Set(files.map((file) => file.oldPath).filter((path): path is string => path !== null));
  const newPaths = new Set(files.map((file) => file.newPath).filter((path): path is string => path !== null));

  for (const file of files) {
    if (!file.analyzed) continue;
    explainSide(file, "old", oldPaths, crossFile, result);
    explainSide(file, "new", newPaths, crossFile, result);
  }
}

/** Explain one side's import tokens for moved symbols. */
function explainSide(file: AnalyzedFile, side: "old" | "new", knownPaths: Set<string>, moves: MoveRecord[], result: MoveResult) {
  const parsed = side === "old" ? file.oldParsed! : file.newParsed!;
  const path = side === "old" ? file.oldPath : file.newPath;
  const stream = side === "old" ? file.old.stream! : file.new.stream!;
  if (!path) return;

  for (const statement of parsed.tree.rootNode.namedChildren) {
    if (statement?.type !== "import_statement") continue;
    const sourceNode = statement.childForFieldName("source");
    if (!sourceNode) continue;
    const resolved = resolveModule(path, sourceNode.text.slice(1, -1), knownPaths);
    if (!resolved) continue;

    const specifiers = statement.descendantsOfType("import_specifier").filter((node) => node !== null);
    const movedSpecifiers = specifiers.filter((specifier) => {
      const name = specifier.childForFieldName("name")?.text;
      return moves.some((move) => move.symbol === name && (side === "old" ? move.oldFile.oldPath === resolved : move.newFile.newPath === resolved));
    });
    if (movedSpecifiers.length === 0) continue;

    const explained = mapFor(side === "old" ? result.explainedOld : result.explainedNew, file);
    const refFor = (name: string | undefined) =>
      moves.find((move) => move.symbol === name && (side === "old" ? move.oldFile.oldPath === resolved : move.newFile.newPath === resolved))!.ref;
    const hasOtherImports = statement.childForFieldName("import")?.namedChildren.some((child) => child?.type === "identifier" || child?.type === "namespace_import");

    if (movedSpecifiers.length === specifiers.length && !hasOtherImports) {
      // The whole statement exists only for moved symbols.
      const ref = refFor(movedSpecifiers[0]!.childForFieldName("name")?.text);
      stream.tokens.forEach((token, index) => {
        if (token.start >= statement.startIndex && token.end <= statement.endIndex) explained.set(index, ref);
      });
      continue;
    }

    for (const specifier of movedSpecifiers) {
      const ref = refFor(specifier.childForFieldName("name")?.text);
      const comma = adjacentComma(specifier);
      stream.tokens.forEach((token, index) => {
        const inSpecifier = token.start >= specifier.startIndex && token.end <= specifier.endIndex;
        const isComma = comma !== null && token.start === comma.startIndex && token.raw === ",";
        if (inSpecifier || isComma) explained.set(index, ref);
      });
    }
  }
}

/** The comma that separates a specifier from its neighbor (preferring the one before it). */
function adjacentComma(specifier: { previousSibling: { type: string; startIndex: number } | null; nextSibling: { type: string; startIndex: number } | null }) {
  if (specifier.previousSibling?.type === ",") return specifier.previousSibling;
  if (specifier.nextSibling?.type === ",") return specifier.nextSibling;
  return null;
}

/** Group items by a key, preserving order. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const list = groups.get(name) ?? [];
    list.push(item);
    groups.set(name, list);
  }

  return groups;
}

/** Set stored per file, created on first use. */
function setFor<T>(map: Map<T, Set<number>>, key: T): Set<number> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }

  return set;
}

/** Map stored per file, created on first use. */
function mapFor<T>(map: Map<T, Map<number, string>>, key: T): Map<number, string> {
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }

  return inner;
}
