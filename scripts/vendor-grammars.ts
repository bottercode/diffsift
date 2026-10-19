/**
 * Copies the pinned tree-sitter grammar WASM files into `wasm/` so diffsift ships only the
 * three binaries it parses with, not the 38 MB grammar packages.
 *
 * Each tarball is checked against the integrity hash npm published for that exact version
 * before anything is extracted, then `wasm/SHA256SUMS` and `THIRD_PARTY_LICENSES.md` are
 * rewritten. Running it twice produces identical files, which CI checks with `git diff`.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PinnedGrammar {
  name: string;
  version: string;
  integrity: string;
  /** Tarball member → file name written to `wasm/`. */
  files: Record<string, string>;
}

const GRAMMARS: PinnedGrammar[] = [
  {
    name: "tree-sitter-typescript",
    version: "0.23.2",
    integrity: "sha512-e04JUUKxTT53/x3Uq1zIL45DoYKVfHH4CZqwgZhPg5qYROl5nQjV+85ruFzFGZxu+QeFVbRTPDRnqL9UbU4VeA==",
    files: {
      "package/tree-sitter-typescript.wasm": "tree-sitter-typescript.wasm",
      "package/tree-sitter-tsx.wasm": "tree-sitter-tsx.wasm",
    },
  },
  {
    name: "tree-sitter-javascript",
    version: "0.25.0",
    integrity: "sha512-1fCbmzAskZkxcZzN41sFZ2br2iqTYP3tKls1b/HKGNPQUVOpsUxpmGxdN/wMqAk3jYZnYBR1dd/y/0avMeU7dw==",
    files: {
      "package/tree-sitter-javascript.wasm": "tree-sitter-javascript.wasm",
    },
  },
];

const root = join(import.meta.dir, "..");
const wasmDir = join(root, "wasm");

/** Download one pinned tarball and refuse it unless its sha512 matches the published integrity. */
async function fetchVerified(grammar: PinnedGrammar): Promise<Uint8Array> {
  const url = `https://registry.npmjs.org/${grammar.name}/-/${grammar.name}-${grammar.version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== grammar.integrity) {
    throw new Error(`${grammar.name}@${grammar.version}: integrity mismatch\n  expected ${grammar.integrity}\n  actual   ${actual}`);
  }

  return bytes;
}

/** Read one member of a gzipped tarball through the system `tar`. */
function extractMember(tarball: string, member: string): Uint8Array {
  const result = Bun.spawnSync(["tar", "-xzOf", tarball, member]);
  if (result.exitCode !== 0) {
    throw new Error(`tar could not read ${member}: ${result.stderr.toString()}`);
  }

  return result.stdout;
}

/** Hex sha256 of some bytes. */
function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

const scratch = mkdtempSync(join(tmpdir(), "diffsift-vendor-"));
const sums: string[] = [];
const licenses: string[] = [];

try {
  for (const grammar of GRAMMARS) {
    const tarball = join(scratch, `${grammar.name}.tgz`);
    writeFileSync(tarball, await fetchVerified(grammar));

    for (const [member, fileName] of Object.entries(grammar.files)) {
      const bytes = extractMember(tarball, member);
      writeFileSync(join(wasmDir, fileName), bytes);
      sums.push(`${sha256(bytes)}  ${fileName}`);
    }

    const license = new TextDecoder().decode(extractMember(tarball, "package/LICENSE")).trim();
    licenses.push(`## ${grammar.name}@${grammar.version}\n\nFiles: ${Object.values(grammar.files).join(", ")}\n\n\`\`\`text\n${license}\n\`\`\``);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

sums.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
writeFileSync(join(wasmDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

const hunkCredit = `## Hunk (modem-dev/hunk)

\`src/patch.ts\` adapts the unified-diff parser from Hunk's bundled search
(packages/hunk/src/extensions/default/ui/search/search.ts) by way of hunk-semantic-search.

\`\`\`text
${readFileSync(join(root, "scripts/hunk-LICENSE.txt"), "utf8").trim()}
\`\`\``;

writeFileSync(
  join(root, "THIRD_PARTY_LICENSES.md"),
  `# Third-party licenses\n\ndiffsift vendors these files. Each keeps its own license.\n\n${[...licenses, hunkCredit].join("\n\n")}\n`,
);

console.log(sums.join("\n"));
