/**
 * Measures diffsift on a real repository. Usage:
 *
 *   bun scripts/eval.ts --repo <dir> [--limit 300] [--agent] [--json out.json]
 *   bun scripts/eval.ts --repo <dir> --synthetic [--limit 200] [--seed 1]
 *
 * History mode sifts each non-merge commit that touches TS/JS (newest first; `--agent` keeps only
 * commits with a coding-agent co-author trailer) and reports how much of each diff is mechanical,
 * why lines stayed real, how often files fail to parse, and runtime.
 *
 * Synthetic mode is the safety check. It reformats tracked files with Prettier in a style opposite
 * to the usual one, which should yield zero real lines (anything else is over-reporting), then
 * injects one seeded behavior change per file into the reformatted text, which must always land on
 * a real line. A single missed mutation is a false "mechanical" label and fails the run.
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import * as prettier from "prettier";
import type { Node } from "web-tree-sitter";
import { defaultParserHost, siftRevision } from "../src/index";
import { grammarFor } from "../src/languages";
import { runGit } from "../src/node/git";
import { sift } from "../src/sift";
import type { Category, SiftResult } from "../src/types";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    limit: { type: "string" },
    agent: { type: "boolean", default: false },
    synthetic: { type: "boolean", default: false },
    seed: { type: "string", default: "1" },
    json: { type: "string" },
  },
});

if (!values.repo) {
  console.error("usage: bun scripts/eval.ts --repo <dir> [--limit N] [--agent | --synthetic] [--seed N] [--json out.json]");
  process.exit(2);
}

const repo = values.repo;
const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.cts", "*.mjs", "*.cjs"];
const AGENT_TRAILER = /^co-authored-by:.*(claude|codex|copilot|cursor|gemini|devin|noreply@anthropic\.com|@openai\.com)/im;

// Behavior-changing swaps the synthetic eval injects into binary expressions.
const OPERATOR_SWAPS: Record<string, string> = {
  "<": "<=",
  "<=": "<",
  ">": ">=",
  ">=": ">",
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  "&&": "||",
  "||": "&&",
  "+": "-",
  "-": "+",
  "??": "||",
};

const report = values.synthetic
  ? await syntheticEval(Number(values.limit ?? 200), Number(values.seed))
  : await historyEval(Number(values.limit ?? 300), values.agent);

if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);

/** Sift recent commits and aggregate categories, ratios, reasons, and runtime. */
async function historyEval(limit: number, agentOnly: boolean) {
  const log = (await runGit(repo, ["log", "--no-merges", "--format=%H%x00%P%x00%B%x01", "--", ...SOURCE_GLOBS])).toString("utf8");
  const commits = log
    .split("\x01")
    .map((record) => record.trim().split("\x00"))
    .filter(([sha, parents]) => sha && parents && parents.split(" ").length === 1)
    .filter(([, , body]) => !agentOnly || AGENT_TRAILER.test(body ?? ""))
    .slice(0, limit)
    .map(([sha]) => sha!);

  const byCategory: Record<Category, number> = { format: 0, comment: 0, rename: 0, move: 0, real: 0 };
  const realReasons = new Map<string, number>();
  const diagnostics = new Map<string, number>();
  const ratios: number[] = [];
  const timings: number[] = [];
  let analyzedFiles = 0;
  let parseErrorFiles = 0;
  let renames = 0;
  let moves = 0;
  let changedInsideMoves = 0;
  const highlights: Array<{ sha: string; ratio: number; changedLines: number; renames: number; moves: number }> = [];

  for (const [index, sha] of commits.entries()) {
    const started = performance.now();
    const result = await siftRevision(repo, `${sha}^..${sha}`);
    timings.push(performance.now() - started);

    for (const category of Object.keys(byCategory) as Category[]) byCategory[category] += result.summary.byCategory[category];
    for (const change of result.realChanges) realReasons.set(change.reason, (realReasons.get(change.reason) ?? 0) + change.endLine - change.line + 1);
    for (const diagnostic of result.diagnostics) diagnostics.set(diagnostic.code, (diagnostics.get(diagnostic.code) ?? 0) + 1);
    const sourceFiles = result.files.filter((file) => file.language !== null);
    analyzedFiles += sourceFiles.length;
    parseErrorFiles += result.diagnostics.filter((diagnostic) => diagnostic.code === "parse-error").length;
    renames += result.renames.length;
    moves += result.moves.length;
    changedInsideMoves += result.moves.filter((move) => move.changedInside).length;

    const analyzedLines = result.summary.changedLines - result.summary.byCategory.comment;
    if (analyzedLines > 0) ratios.push(result.summary.mechanicalRatio);
    if (result.summary.mechanicalRatio >= 0.5 && result.summary.changedLines >= 20) {
      highlights.push({ sha: sha.slice(0, 10), ratio: result.summary.mechanicalRatio, changedLines: result.summary.changedLines, renames: result.renames.length, moves: result.moves.length });
    }

    if ((index + 1) % 25 === 0) console.error(`… ${index + 1}/${commits.length}`);
  }

  const total = Object.values(byCategory).reduce((sum, count) => sum + count, 0);
  const mechanical = byCategory.format + byCategory.rename + byCategory.move;
  const summary = {
    mode: agentOnly ? "history (agent commits)" : "history",
    commits: commits.length,
    changedLines: total,
    byCategory,
    mechanicalShareOfAllLines: round(mechanical / Math.max(1, total - byCategory.comment)),
    perCommitMechanicalRatio: { p50: percentile(ratios, 0.5), mean: round(mean(ratios)), p90: percentile(ratios, 0.9) },
    commitsAtLeastHalfMechanical: ratios.filter((ratio) => ratio >= 0.5).length,
    renames,
    moves,
    changedInsideMoves,
    sourceFiles: analyzedFiles,
    parseErrorRate: round(parseErrorFiles / Math.max(1, analyzedFiles)),
    realLinesByReason: Object.fromEntries([...realReasons].sort((a, b) => b[1] - a[1])),
    diagnostics: Object.fromEntries([...diagnostics].sort((a, b) => b[1] - a[1])),
    msPerCommit: { p50: Math.round(percentile(timings, 0.5)), p90: Math.round(percentile(timings, 0.9)), max: Math.round(Math.max(0, ...timings)) },
    mostMechanicalCommits: highlights.sort((a, b) => b.ratio * b.changedLines - a.ratio * a.changedLines).slice(0, 10),
  };

  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

/** Reformat tracked files with Prettier, then inject one mutation each; report over-reporting and recall. */
async function syntheticEval(limit: number, seed: number) {
  const random = mulberry32(seed);
  const tracked = (await runGit(repo, ["ls-files", "-z", "--", ...SOURCE_GLOBS])).toString("utf8").split("\0").filter(Boolean);
  const sample = shuffle(tracked, random).slice(0, limit).sort();
  const host = await defaultParserHost();

  let reformatted = 0;
  let skipped = 0;
  let changedLines = 0;
  let realLines = 0;
  let cleanFiles = 0;
  const overReports: Array<{ file: string; line: number; text: string }> = [];
  let mutations = 0;
  let detected = 0;
  let detectedNearby = 0;
  const misses: Array<{ file: string; line: number; mutation: string }> = [];

  for (const path of sample) {
    const grammar = grammarFor(path);
    const original = (await runGit(repo, ["show", `HEAD:${path}`])).toString("utf8");
    if (!grammar || original.length > 200_000) {
      skipped += 1;
      continue;
    }

    const parsedOriginal = host.parse(grammar, original);
    const parses = parsedOriginal.ok;
    host.dispose(parsedOriginal);
    const formatted = parses ? await reformat(path, original) : null;
    if (formatted === null || formatted === original) {
      skipped += 1;
      continue;
    }

    reformatted += 1;
    const formatResult = await siftPair(path, original, formatted);
    changedLines += formatResult.summary.changedLines;
    realLines += formatResult.summary.realLines;
    if (formatResult.summary.realLines === 0) cleanFiles += 1;
    for (const change of formatResult.realChanges.slice(0, 2)) {
      if (overReports.length < 40) overReports.push({ file: path, line: change.line, text: (formatted.split("\n")[change.line - 1] ?? "").trim().slice(0, 100) });
    }

    const mutation = mutate(host, grammar, formatted, random);
    if (!mutation) continue;
    mutations += 1;
    const mutatedResult = await siftPair(path, original, mutation.text);
    const lines = mutatedResult.files[0]?.lines ?? [];
    // An equally minimal token alignment can pin the edit on a neighboring line (`true, false` →
    // `false, false` deletes `true` and adds the second `false`); that still reports the change, as
    // long as the mutation added real lines beyond the reformat-only baseline.
    const exact = lines.some((entry) => entry.side === "new" && entry.line === mutation.line && entry.category === "real");
    const nearby = !exact && mutatedResult.summary.realLines > formatResult.summary.realLines;
    if (nearby) detectedNearby += 1;
    if (exact || nearby) detected += 1;
    else misses.push({ file: path, line: mutation.line, mutation: mutation.label });
  }

  const summary = {
    mode: "synthetic",
    seed,
    sampled: sample.length,
    reformatted,
    skipped,
    reformatOnly: {
      changedLines,
      realLines,
      overReportRate: round(realLines / Math.max(1, changedLines)),
      filesWithZeroRealLines: cleanFiles,
    },
    mutations: { injected: mutations, detected, detectedOnNeighborLine: detectedNearby, recall: round(detected / Math.max(1, mutations)), misses },
    overReportExamples: overReports,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (misses.length > 0) process.exitCode = 1;
  return summary;
}

/** Sift one in-memory pair in files mode. */
async function siftPair(path: string, oldText: string, newText: string): Promise<SiftResult> {
  return sift([{ oldPath: path, newPath: path, oldText, newText, status: "modified" }], await defaultParserHost(), {
    source: { kind: "files", diffAlgorithm: "myers" },
  });
}

/** Prettier with the opposite of the common TS style; null when Prettier cannot parse the file. */
async function reformat(path: string, text: string): Promise<string | null> {
  try {
    return await prettier.format(text, {
      filepath: path,
      singleQuote: true,
      semi: false,
      trailingComma: "none",
      arrowParens: "avoid",
      quoteProps: "consistent",
      bracketSpacing: false,
      printWidth: 100,
    });
  } catch {
    return null;
  }
}

/** Change one seeded token so the program's behavior differs: an operator, literal, or boolean. */
function mutate(host: Awaited<ReturnType<typeof defaultParserHost>>, grammar: NonNullable<ReturnType<typeof grammarFor>>, text: string, random: () => number) {
  const parsed = host.parse(grammar, text);
  try {
    if (!parsed.ok) return null;
    const candidates: Array<{ node: Node; replacement: string; label: string }> = [];
    const visit = (node: Node) => {
      if (node.childCount === 0) {
        const parent = node.parent?.type ?? "";
        if (parent === "binary_expression" && OPERATOR_SWAPS[node.type]) candidates.push({ node, replacement: OPERATOR_SWAPS[node.type]!, label: `${node.type} → ${OPERATOR_SWAPS[node.type]}` });
        else if (node.type === "number" && /^\d+$/.test(node.text)) candidates.push({ node, replacement: String(Number(node.text) + 1), label: `${node.text} → ${Number(node.text) + 1}` });
        else if (node.type === "string_fragment" && parent === "string") candidates.push({ node, replacement: `${node.text}x`, label: "string + x" });
        else if (node.type === "true" || node.type === "false") candidates.push({ node, replacement: node.type === "true" ? "false" : "true", label: `${node.type} flipped` });
        return;
      }

      for (const child of node.children) if (child) visit(child);
    };
    visit(parsed.tree.rootNode);
    if (candidates.length === 0) return null;

    const pick = candidates[Math.floor(random() * candidates.length)]!;
    return {
      text: text.slice(0, pick.node.startIndex) + pick.replacement + text.slice(pick.node.endIndex),
      line: pick.node.startPosition.row + 1,
      label: pick.label,
    };
  } finally {
    host.dispose(parsed);
  }
}

/** Seeded PRNG so synthetic runs are reproducible. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle with the given PRNG. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

/** Value at a quantile of an unsorted list. */
function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!);
}

/** Arithmetic mean, 0 for an empty list. */
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Round to four decimals for stable reports. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
