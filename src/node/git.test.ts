import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { siftGit, siftRevision } from "../index";
import { createTestRepo, testGit, writeTestTree } from "../../test/helpers";
import { parseRevisionArgument } from "./git";

const golden = join(import.meta.dir, "../../test/fixtures/golden-agent-refactor");
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Temporary repo from a fixture, cleaned up after the test. */
function repoFrom(fixture: string, extra: Record<string, string> = {}) {
  const repo = createTestRepo(fixture, extra);
  cleanups.push(repo.cleanup);
  return repo.root;
}

describe("git mode", () => {
  test("analyzes a commit range with git's hunks", async () => {
    const root = repoFrom(golden);
    const result = await siftRevision(root, "base..HEAD");

    expect(result.source).toMatchObject({ kind: "range", base: "base", head: "HEAD" });
    expect(result.summary.realLines).toBe(1);
    expect(result.renames.map((rename) => [rename.from, rename.to, rename.count])).toEqual([["getUser", "fetchUser", 3]]);
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]).toMatchObject({ symbol: "isExpired", changedInside: true, to: { file: "src/auth/session.ts" } });
  });

  test("A...B diffs from the merge base", async () => {
    const root = repoFrom(golden);
    testGit(root, "checkout", "-q", "-b", "side", "base");
    writeTestTree(root, { "side.ts": "export const side = 1;\n" });
    testGit(root, "add", "-A");
    testGit(root, "commit", "-q", "-m", "side");

    const spec = await parseRevisionArgument(root, "side...main", false);
    expect(spec.kind).toBe("range");
    const result = await siftGit(root, spec);
    expect(result.files.map((file) => file.newPath ?? file.oldPath).sort()).toEqual(["src/api.ts", "src/auth/session.ts", "src/utils.ts"]);
  });

  test("staged and working tree changes, including untracked files", async () => {
    const root = repoFrom(golden);
    writeFileSync(join(root, "src/api.ts"), "import { fetchUser } from './utils'\n");
    testGit(root, "add", "src/api.ts");
    writeTestTree(root, { "src/new.ts": "export const fresh = 1;\n" });

    const staged = await siftRevision(root, undefined, true);
    expect(staged.files.map((file) => file.newPath)).toEqual(["src/api.ts"]);

    const worktree = await siftRevision(root, undefined);
    expect(worktree.files.map((file) => file.newPath).sort()).toEqual(["src/api.ts", "src/new.ts"]);
    expect(worktree.files.find((file) => file.newPath === "src/new.ts")!.status).toBe("added");
  });

  test("treats a file removed from the index but still on disk as modified", async () => {
    const root = repoFrom(golden);
    testGit(root, "checkout", "-q", "base");
    writeFileSync(join(root, "src/utils.ts"), "export function getUser(id: string) {\n  return db.query('select * from users where id = ?', [id]);\n}\n");
    testGit(root, "rm", "-q", "--cached", "src/utils.ts");

    const result = await siftRevision(root, undefined);
    const utils = result.files.filter((file) => (file.newPath ?? file.oldPath) === "src/utils.ts");
    expect(utils.map((file) => file.status)).toEqual(["modified"]);
  });

  test("limits analysis to pathspecs", async () => {
    const root = repoFrom(golden);
    const result = await siftRevision(root, "base..HEAD", false, { paths: ["src/api.ts"] });
    expect(result.files.map((file) => file.newPath)).toEqual(["src/api.ts"]);
    // With its source file out of scope, the rename cannot be proven here.
    expect(result.renames).toEqual([]);
  });

  test("reports pure file renames and skips binary files", async () => {
    const root = repoFrom(golden);
    testGit(root, "mv", "src/utils.ts", "src/users.ts");
    writeTestTree(root, { "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) });
    testGit(root, "add", "-A");
    testGit(root, "commit", "-q", "-m", "rename");

    const result = await siftRevision(root, "HEAD~1..HEAD");
    expect(result.fileMoves).toEqual([{ from: "src/utils.ts", to: "src/users.ts" }]);
    const logo = result.files.find((file) => file.newPath === "logo.png")!;
    expect(logo.analyzed).toBe(false);
  });

  test("refuses revisions that look like options", async () => {
    const root = repoFrom(golden);
    await expect(siftRevision(root, "--output=/tmp/pwned")).rejects.toThrow("refusing revision");
    await expect(siftRevision(root, "base..--upload-pack=x")).rejects.toThrow("refusing revision");
  });

  test("refuses an exported rename that an unchanged file still uses", async () => {
    const root = repoFrom(golden, { "src/legacy.ts": "import { getUser } from './utils';\nexport const legacy = getUser;\n" });
    const result = await siftRevision(root, "base..HEAD");
    expect(result.renames).toEqual([]);
    expect(result.summary.realLines).toBeGreaterThan(1);
  });
});
