/**
 * Keeps the published surfaces consistent: one version across package.json, the CLI/MCP/result
 * constant, the Claude Code plugin, and the MCP command it runs; a well-formed skill; and every
 * path the package ships actually exists.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version";

const root = join(import.meta.dir, "..");

/** Parse a JSON file relative to the package root. */
function readTestJson(path: string) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("package surfaces", () => {
  const pkg = readTestJson("package.json");

  test("every version matches package.json", () => {
    const plugin = readTestJson(".claude-plugin/plugin.json");
    expect(VERSION).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.mcpServers.diffsift.args).toEqual(["-y", `diffsift@${pkg.version}`, "mcp"]);
  });

  test("the skill has agent-skills frontmatter naming its directory", () => {
    const skill = readFileSync(join(root, "skills/diffsift/SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(frontmatter).toMatch(/^name: diffsift$/m);
    expect(/^description: (.+)$/m.exec(frontmatter)?.[1]?.length ?? 0).toBeGreaterThan(80);
  });

  test("shipped files and exports exist", () => {
    const shipped = (pkg.files as string[]).filter((path) => path !== "dist" && path !== "README.md");
    for (const path of shipped) expect({ path, exists: existsSync(join(root, path)) }).toEqual({ path, exists: true });
    expect(existsSync(join(root, pkg.exports["./schema.json"]))).toBe(true);
  });
});
