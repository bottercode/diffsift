---
name: diffsift
description: Separates the real behavior changes in a TypeScript/JavaScript git diff from mechanical noise (formatting, consistent renames, moved declarations, comment-only edits) and flags code that was edited while being moved. Use before reviewing, summarizing, or writing a commit message or PR description for TS/JS changes, especially large refactors or formatter runs.
---

# diffsift

diffsift reads a git diff of TypeScript/JavaScript files, parses both versions, and labels every
changed line as `format`, `comment`, `rename`, `move`, or `real`. Mechanical labels are only given
when they are proven; anything uncertain is reported as `real`. Use it so you review the few real
lines instead of the whole diff, and so you do not miss an edit hidden inside moved code.

## Run it

With the MCP server connected (tools `sift_changes` and `real_changes`), prefer the tools. Otherwise
use the CLI; it needs Node 22+ and git, and runs from the repository:

```sh
npx -y diffsift                     # working tree vs HEAD, including untracked files
npx -y diffsift --staged            # what is about to be committed
npx -y diffsift main...HEAD         # a branch since it left main
npx -y diffsift HEAD~1..HEAD        # one commit
npx -y diffsift main...HEAD -- src  # limited to paths
npx -y diffsift main...HEAD --json  # schema v1 JSON for parsing
npx -y diffsift main...HEAD --only real
```

MCP tools take the same scope as arguments: `repo`, `range` (`main...HEAD`, `HEAD~1`; omit for the
working tree), `staged`, `paths`.

- `sift_changes` → summary, renames, moves, formatting files, real changes, diagnostics. Pass
  `detail: "lines"` only when you need each line's category.
- `real_changes` → only the real edits, with old and new snippets and the enclosing symbol. Start here
  when reviewing.

## Read the result

- `summary.mechanicalRatio` is the share of changed lines that are proven mechanical;
  `summary.realLines` counts lines that need a human or agent to read them.
- `renames[]`: a symbol renamed consistently at every use (`count` places). Do not re-review each use.
- `moves[]`: a declaration moved within or between files. **`changedInside: true` means it was also
  edited while moving.** Review those lines first: a line diff shows them as a plain move, so they
  are the edits reviewers miss most.
- `formatFiles[]`: formatter churn (quotes, semicolons, trailing commas, parens, wrapping). Skip it.
- `realChanges[]`: everything else, grouped into ranges with a `reason`. `reason: "changed"` is an
  ordinary edit; `parse-error`, `unsupported-language`, `binary`, `too-large`, and
  `move-order-sensitive` mean the file or declaration was not proven, so read the git diff for it.
- `diagnostics[]` and `files[].analyzed: false`: not analyzed. Treat all their changes as real.

## Rules

- `real` may over-report; mechanical never should. Read every real change, but do not re-check
  lines labeled `format`, `rename`, or `move` (except moves with `changedInside`).
- Never tell the user a change has "no behavior change" when `realLines > 0`, when any move has
  `changedInside: true`, or when `diagnostics` is non-empty.
- When summarizing a diff or writing a commit/PR message, lead with the real changes, then mention
  the mechanical work in one line ("renamed `getUser` → `fetchUser` in 3 places; moved `isExpired`
  to `auth/session.ts`; Prettier formatting in 11 files").
- Only TS, TSX, JS, JSX, MTS, CTS, MJS, and CJS files are analyzed. Other files appear as unanalyzed.
