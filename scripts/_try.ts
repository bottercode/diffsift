import { siftRevision } from "../src/index";
const [repo, range] = process.argv.slice(2);
const t = performance.now();
const r = await siftRevision(repo!, range);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t), summary: r.summary, renames: r.renames.map(x => `${x.from}->${x.to} x${x.count}`), moves: r.moves.map(m => `${m.symbol} ${m.from.file}->${m.to.file}${m.changedInside ? " *" : ""}`), formatFiles: r.formatFiles.length, real: r.realChanges.length, diag: r.diagnostics.map(d => `${d.file}:${d.code}`).slice(0, 8) }, null, 1));
