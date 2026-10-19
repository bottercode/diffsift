/**
 * Serves diffsift to coding agents over MCP (stdio), started with `diffsift mcp`. Agents call
 * `sift_changes` for the overall picture and `real_changes` for the lines that need review, with
 * code snippets, so they can skip formatting, renames, and moves without reading them.
 *
 * Both tools are read-only. The repository is validated with git, paths must stay inside it,
 * revisions that look like options are refused, and all logging goes to stderr so stdout stays
 * a clean protocol stream.
 */

import { isAbsolute, normalize } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultParserHost } from "./index";
import { parseRevisionArgument, readGitPairs, runGit } from "./node/git";
import { sift } from "./sift";
import type { FilePair, SiftResult } from "./types";
import { VERSION } from "./version";

const scopeShape = {
  repo: z.string().optional().describe("Repository directory; defaults to the server's working directory."),
  range: z
    .string()
    .optional()
    .describe("Git range or revision: 'main..HEAD', 'main...HEAD', 'HEAD~1'. Omit for working tree vs HEAD (with untracked files)."),
  staged: z.boolean().optional().describe("Analyze staged changes instead (range then names the base, default HEAD)."),
  paths: z.array(z.string()).optional().describe("Limit to these repository-relative paths."),
};

/** Build the server with both tools registered. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "diffsift", version: VERSION });

  server.registerTool(
    "sift_changes",
    {
      title: "Sift changes",
      description:
        "Separate mechanical changes (formatting, consistent renames, moved declarations, comment-only edits) from real behavior changes in a TypeScript/JavaScript git diff. Returns diffsift schema v1 JSON: summary, renames, moves, formatFiles, realChanges, diagnostics. Mechanical labels are proven; files in diagnostics were not analyzed and all their changes count as real.",
      inputSchema: {
        ...scopeShape,
        detail: z.enum(["summary", "lines"]).optional().describe("'summary' (default) omits per-line entries; 'lines' includes every changed line's category."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      respond(async () => {
        const { result } = await run(args);
        return args.detail === "lines" ? result : summarize(result);
      }),
  );

  server.registerTool(
    "real_changes",
    {
      title: "Real changes",
      description:
        "List only the real (behavior-changing) edits in a TypeScript/JavaScript git diff, with old and new code snippets and the enclosing symbol, plus declarations that were edited while being moved. Review these instead of the whole diff.",
      inputSchema: {
        ...scopeShape,
        context: z.number().int().min(0).max(10).optional().describe("Lines of context around each change (default 2)."),
        limit: z.number().int().min(1).max(500).optional().describe("Most changes to return (default 50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      respond(async () => {
        const { result, pairs } = await run(args);
        return realChangesReport(result, pairs, args.context ?? 2, args.limit ?? 50);
      }),
  );

  return server;
}

/** Start the server on stdio. */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`diffsift ${VERSION} MCP server ready on stdio\n`);
}

/** Run an analysis for tool arguments after validating them. */
async function run(args: { repo?: string; range?: string; staged?: boolean; paths?: string[] }) {
  const repo = args.repo ?? process.cwd();
  await runGit(repo, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error(`not a git repository: ${repo}`);
  });

  const paths = args.paths ?? [];
  for (const path of paths) {
    if (isAbsolute(path) || normalize(path).startsWith("..") || path.startsWith("-")) {
      throw new Error(`path must be inside the repository: ${path}`);
    }
  }

  const spec = await parseRevisionArgument(repo, args.range, Boolean(args.staged));
  const { pairs, source, staleReferences } = await readGitPairs(repo, spec, paths);
  const result = await sift(pairs, await defaultParserHost(), { source, staleReferences });
  return { result, pairs };
}

/** Wrap a handler's value or error as a tool result. */
async function respond(produce: () => Promise<unknown>) {
  try {
    const value = await produce();
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

/** The result without per-line entries, which keeps agent context small. */
function summarize(result: SiftResult) {
  return {
    ...result,
    files: result.files.map(({ lines, ...file }) => ({
      ...file,
      counts: lines.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.category]: (counts[entry.category] ?? 0) + 1 }), {}),
    })),
  };
}

/** Real changes with snippets, plus moves edited in place. */
function realChangesReport(result: SiftResult, pairs: readonly FilePair[], context: number, limit: number) {
  const text = (file: string, side: "old" | "new") => {
    const pair = pairs.find((candidate) => (side === "old" ? candidate.oldPath : candidate.newPath) === file);
    return pair ? (side === "old" ? pair.oldText : pair.newText).split("\n") : [];
  };
  const snippet = (file: string, side: "old" | "new", from: number, to: number) => {
    const lines = text(file, side);
    const start = Math.max(1, from - context);
    const end = Math.min(lines.length, to + context, from + 40);
    const out: string[] = [];
    for (let line = start; line <= end; line++) {
      const marker = line >= from && line <= to ? (side === "old" ? "-" : "+") : " ";
      out.push(`${marker}${String(line).padStart(5)}  ${(lines[line - 1] ?? "").replace(/\r$/, "")}`);
    }
    return out.join("\n");
  };

  const changes = result.realChanges.slice(0, limit).map((change) => {
    const oldFile = change.side === "new" ? (change.oldFile ?? findOldPath(pairs, change.file)) : change.file;
    return {
      ...change,
      new: change.side === "new" ? snippet(change.file, "new", change.line, change.endLine) : undefined,
      old:
        change.side === "old"
          ? snippet(change.file, "old", change.line, change.endLine)
          : change.oldLine !== undefined && oldFile
            ? snippet(oldFile, "old", change.oldLine, change.oldEndLine ?? change.oldLine)
            : undefined,
    };
  });

  return {
    summary: result.summary,
    changes,
    truncated: result.realChanges.length > limit,
    movedWithEdits: result.moves.filter((move) => move.changedInside),
    diagnostics: result.diagnostics,
  };
}

/** Old path for a new path (renamed files keep their old name on the old side). */
function findOldPath(pairs: readonly FilePair[], newPath: string): string | null {
  return pairs.find((pair) => pair.newPath === newPath)?.oldPath ?? null;
}
