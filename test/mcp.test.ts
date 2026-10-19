/**
 * Talks to `diffsift mcp` over stdio with the MCP SDK client, the way an agent harness does.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestRepo } from "./helpers";

const golden = join(import.meta.dir, "fixtures/golden-agent-refactor");
let repo: ReturnType<typeof createTestRepo>;
let client: Client;

beforeAll(async () => {
  repo = createTestRepo(golden);
  client = new Client({ name: "diffsift-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/cli.ts"), "mcp"], cwd: repo.root, stderr: "ignore" }),
  );
});

afterAll(async () => {
  await client.close();
  repo.cleanup();
});

/** Call a tool and parse its JSON text content. */
async function callJson(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]!.text };
}

describe("MCP server", () => {
  test("lists both read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["real_changes", "sift_changes"]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  test("sift_changes returns the summary without per-line entries", async () => {
    const { isError, text } = await callJson("sift_changes", { range: "base..HEAD" });
    expect(isError).toBe(false);
    const result = JSON.parse(text);
    expect(result.schemaVersion).toBe(1);
    expect(result.summary.realLines).toBe(1);
    expect(result.files[0].lines).toBeUndefined();
    expect(result.files[0].counts).toBeDefined();
  });

  test("real_changes returns snippets for the edit inside the moved function", async () => {
    const { text } = await callJson("real_changes", { range: "base..HEAD", context: 1 });
    const report = JSON.parse(text);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ file: "src/auth/session.ts", symbol: "isExpired" });
    expect(report.changes[0].new).toContain("+    2    return session.expiresAt <= Date.now();");
    expect(report.changes[0].old).toContain("return session.expiresAt < Date.now()");
    expect(report.movedWithEdits).toHaveLength(1);
  });

  test("rejects option-like ranges and paths outside the repository", async () => {
    expect((await callJson("sift_changes", { range: "--output=/tmp/x" })).isError).toBe(true);
    expect((await callJson("sift_changes", { paths: ["../outside.ts"] })).isError).toBe(true);
    expect((await callJson("sift_changes", { repo: "/" })).isError).toBe(true);
  });
});
