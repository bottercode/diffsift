/**
 * Declares diffsift's input shapes and its versioned JSON output (schema v1). Renderers such as
 * diff viewers map `files[].lines` onto unified-diff rows by side and line number; agents read
 * `summary`, `realChanges`, `renames`, and `moves`.
 *
 * Lines not listed in `files[].lines` are unchanged (or equal modulo formatting). Every line git
 * reports as changed is listed with exactly one category.
 */

import type { HunkRange } from "./patch";
import type { FormatRule } from "./tokens";

export type Side = "old" | "new";

export type Category = "format" | "comment" | "rename" | "move" | "real";

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

/** One file's two versions, as read from git or from disk. */
export interface FilePair {
  oldPath: string | null;
  newPath: string | null;
  oldText: string;
  newText: string;
  status: FileStatus;
  /** Git's similarity score for renames and copies, 0–100. */
  similarity?: number;
  /** Line-level hunks to classify; computed from the texts when absent. */
  hunks?: HunkRange[];
  binary?: boolean;
}

export type RealReason =
  | "changed"
  | "unparsed"
  | "parse-error"
  | "unsupported-language"
  | "binary"
  | "too-large"
  | "move-order-sensitive"
  | "diff-too-large";

export interface LineEntry {
  side: Side;
  line: number;
  category: Category;
  /** Id of the rename (`r1`) or move (`m1`) that explains the line. */
  ref?: string;
  reason?: RealReason;
}

export interface FileResult {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  similarity?: number;
  language: string | null;
  analyzed: boolean;
  /** True when every changed line is formatting. */
  formatOnly: boolean;
  hunks: string[];
  lines: LineEntry[];
}

export interface Location {
  file: string;
  line: number;
}

export interface Rename {
  id: string;
  from: string;
  to: string;
  kind: string;
  scope: "module" | "local" | "type";
  exported: boolean;
  count: number;
  declaredIn: Location;
  occurrences: Location[];
  /** Files mode cannot check files outside the pair for leftover references. */
  crossFileUnverified?: boolean;
}

export interface Move {
  id: string;
  symbol: string;
  kind: string;
  from: { file: string; startLine: number; endLine: number };
  to: { file: string; startLine: number; endLine: number };
  renamedFrom?: string;
  exportAdded?: boolean;
  /** True when the declaration was edited while being moved. */
  changedInside: boolean;
  changedLines: Array<{ side: Side; file: string; line: number }>;
}

export interface RealChange {
  file: string;
  side: Side;
  line: number;
  endLine: number;
  oldLine?: number;
  oldEndLine?: number;
  reason: RealReason;
  /** Enclosing declaration, when known. */
  symbol?: string;
}

export interface FormatFile {
  file: string;
  lines: number;
  kinds: Array<FormatRule | "whitespace">;
  formatOnly: boolean;
}

export interface Diagnostic {
  file?: string;
  code: string;
  message: string;
}

export interface SiftResult {
  schemaVersion: 1;
  tool: { name: "diffsift"; version: string };
  source: { kind: "range" | "staged" | "worktree" | "files"; base?: string; head?: string; diffAlgorithm: string };
  summary: {
    files: number;
    changedLines: number;
    byCategory: Record<Category, number>;
    /** (format + rename + move) / changed lines in analyzed files; comments are excluded from both. */
    mechanicalRatio: number;
    realLines: number;
  };
  renames: Rename[];
  moves: Move[];
  fileMoves: Array<{ from: string; to: string }>;
  formatFiles: FormatFile[];
  realChanges: RealChange[];
  files: FileResult[];
  diagnostics: Diagnostic[];
}
