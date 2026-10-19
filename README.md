# diffsift

Find the **real changes** in a TypeScript/JavaScript diff. diffsift separates formatting, consistent renames, and moved code from edits that change behavior, and it catches the one that line diffs hide best: **code that was edited while being moved**.

An agent renames `getUser` to `fetchUser`, moves `isExpired` into a new file, runs Prettier, and changes one `<` to `<=` along the way. Every diff viewer shows 20 red and green lines, and the `<=` sits inside a brand-new file that looks like a plain move. diffsift shows this:

```text
diffsift base..HEAD · 3 files · 20 changed lines · 18 mechanical (90%)
  ✓ rename  getUser → fetchUser   3 places in 2 files, exported
  ⚠ move    isExpired  src/utils.ts → src/auth/session.ts   changed while moving
            - src/utils.ts:6  return session.expiresAt < Date.now()
            + src/auth/session.ts:2  return session.expiresAt <= Date.now();
  ✓ format  8 lines in src/api.ts, src/utils.ts   quotes, semicolons, whitespace

Real changes: 1 line
  src/auth/session.ts:2  in isExpired
    + return session.expiresAt <= Date.now();
```

It parses both versions of each file with [tree-sitter](https://tree-sitter.github.io/), so it compares code, not text. It's deterministic, runs locally, and is **conservative**: a line is labeled mechanical only when that is proven, and everything else stays real.

## Install

Requires Node 22 or newer, and git.

```sh
npx diffsift main...HEAD        # try it without installing
npm install -g diffsift         # or install the `diffsift` command
```

**For coding agents.** diffsift ships an [agent skill](skills/diffsift/SKILL.md) and an MCP server, so agents review the real changes instead of reading the whole diff. Agent apps such as Paseo, T3 Code, and Conductor run these agents, so installing it in the agent covers them too.

- **Claude Code:** `/plugin marketplace add bottercode/diffsift`, then `/plugin install diffsift@diffsift`. This installs the skill and the MCP server together.
- **Codex, opencode, Cursor, and other agents that read skills:** copy [`skills/diffsift`](skills/diffsift) into `.agents/skills/` (or your agent's skills directory). The skill works through the CLI alone.
- **Any MCP client:** run `npx -y diffsift mcp` over stdio. For example, in Codex's `~/.codex/config.toml`:

  ```toml
  [mcp_servers.diffsift]
  command = "npx"
  args = ["-y", "diffsift", "mcp"]
  ```

## Use

```sh
diffsift                        # working tree vs HEAD, including untracked files
diffsift --staged               # what you're about to commit
diffsift main...HEAD            # a branch since it left main
diffsift HEAD~1..HEAD -- src    # one commit, limited to paths
diffsift --files old.ts new.ts  # two files on disk
diffsift main...HEAD --only real
diffsift main...HEAD --json     # schema v1 JSON
diffsift --exit-code            # exit 1 when anything is real or unanalyzed, for scripts
```

Each changed line gets exactly one category:

| Category | Meaning |
| --- | --- |
| `format` | Same code after normalizing whitespace, quotes, semicolons, trailing commas, optional parens, number spelling, and quoted keys |
| `comment` | Only comments changed (directive comments such as `@ts-ignore` or `eslint-disable` are real) |
| `rename` | A symbol renamed consistently at its declaration and every use |
| `move` | A declaration moved within or between files; `changed while moving` marks edited ones |
| `real` | Everything else, including anything diffsift could not prove |

The MCP server has two read-only tools: `sift_changes` (the summary, renames, moves, and real changes) and `real_changes` (only the real edits, with old and new snippets). The JSON output follows [`schema/diffsift.schema.v1.json`](schema/diffsift.schema.v1.json), exported as `diffsift/schema.json`.

### As a library

```ts
import { siftRevision } from "diffsift";

const result = await siftRevision(process.cwd(), "main...HEAD");
result.realChanges;   // line ranges that need review
result.files[0].lines; // { side, line, category } for every changed line, to color a diff view
```

`diffsift/browser` runs the same analysis without Node built-ins: pass the grammar files (exported as `diffsift/wasm/*`) and the file pairs you already have to `createSifter`.

## How it works

1. git supplies each changed file's two versions and its hunks.
2. tree-sitter parses both versions. Files that don't parse cleanly are not analyzed, and all their changes stay real.
3. Each file becomes a list of normalized tokens. Formatting differences that never change behavior normalize away (`'a'` and `"a"` become equal); anything that can matter, such as template literal text, regexes, or a semicolon that changes how a line parses, stays distinct.
4. Declarations are matched across files by name and by body fingerprint, giving moves and renames. A rename is accepted only when it is consistent everywhere: no leftover references (including in unchanged files), no shadowing, and no swaps.
5. A token diff inside each git hunk decides each line's category, and real wins over everything else.

## How well does it work?

[`scripts/eval.ts`](scripts/eval.ts) measures two things on the [Hunk](https://github.com/modem-dev/hunk) repository.

**Safety: does it ever call a real change mechanical?** The synthetic eval reformats tracked files with Prettier in the opposite style (single quotes, no semicolons, no trailing commas, different wrapping), then injects one seeded behavior change per file, such as `<` → `<=`, `true` → `false`, a number, or a string:

| Seeds | Files | Reformatted lines labeled real | Injected changes reported as real |
| --- | --- | --- | --- |
| 1, 2, 3 | 599 | **0 of 167,324** | **595 of 595** |

**Usefulness on real commits:**

| Commits | Changed lines | Proven mechanical | Median per commit | Moves edited while moving |
| --- | --- | --- | --- | --- |
| Last 300 | 296,712 | 12% | 12% | 50 |
| 104 agent-written | 107,194 | 13% | 13% | 8 |

Hunk runs a formatter on every commit, so there is little formatting churn here to remove; repositories without an enforced formatter haven't been measured yet. The most mechanical Hunk commit, a 919-line refactor, is 83% mechanical, and the 7 functions and interfaces it edited while moving are exactly the lines to review. 0.3% of TS files fail to parse with the current grammars, and their changes count as real. Median runtime is 0.2 seconds per commit (p90 0.9 seconds).

```sh
bun scripts/eval.ts --repo ~/Developer/hunk --limit 300 [--agent]
bun scripts/eval.ts --repo ~/Developer/hunk --synthetic --limit 200 --seed 1
```

## Limitations

- **TypeScript and JavaScript only** (`.ts .tsx .js .jsx .mts .cts .mjs .cjs`). Other files appear as not analyzed.
- **It over-reports rather than under-reports.** Reordered statements, imports, or object keys, extracted functions, destructured declarations, and renames combined with edits stay real.
- **Line numbers follow git's diff.** A viewer that computes its own diff can disagree on which lines changed; `files[].hunks` and `source.diffAlgorithm` record what diffsift used.
- Files over 1 MB (`--max-file-bytes`) or too large to diff at token level are not analyzed.
- Why a rename was refused is not reported yet.

## Development

```sh
bun install
bun run typecheck && bun test
bun run vendor && git diff --exit-code wasm/            # re-download and verify the pinned grammars
bun run build && DIFFSIFT_RUN_NODE_SMOKE=1 bun test test/node.smoke.test.ts
UPDATE_FIXTURES=1 bun test test/fixtures.test.ts        # after a deliberate behavior change; review the diff
```

Fixtures live in `test/fixtures/<case>/{old,new,expected.json}`, one per formatting, move, and rename rule, including the cases that must stay real.

## License

MIT. The bundled tree-sitter grammars are MIT-licensed; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). The unified-diff parser is adapted from [Hunk](https://github.com/modem-dev/hunk) (MIT).
