/**
 * Computes a shortest edit script between two key sequences with Myers' O(ND) algorithm.
 *
 * Keys are compared with `===`, so callers pass pre-normalized strings. Common prefixes and
 * suffixes are trimmed before the search, ties always prefer deleting from `a` first, and the
 * same inputs always produce the same script. When the edit distance exceeds `maxCost` the
 * search stops and reports every non-trimmed element as changed, which callers treat as "real".
 */

export interface MyersResult {
  /** Index pairs `[i, j]` with `a[i] === b[j]`, strictly increasing in both coordinates. */
  pairs: Array<[number, number]>;
  /** `true` when the cost cap was hit and the middle section was reported as fully changed. */
  capped: boolean;
}

export interface MyersOptions {
  /** Largest edit distance to search before giving up; defaults to 4000. */
  maxCost?: number;
}

/** Align two sequences and return the matching index pairs. */
export function myersDiff(a: readonly string[], b: readonly string[], options: MyersOptions = {}): MyersResult {
  const maxCost = options.maxCost ?? 4000;
  const pairs: Array<[number, number]> = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs.push([start, start]);
    start += 1;
  }

  let endA = a.length;
  let endB = b.length;
  const suffix: Array<[number, number]> = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    suffix.push([endA, endB]);
  }

  const middle = searchMiddle(a, b, start, endA, start, endB, maxCost);
  if (middle === null) {
    return { pairs: [...pairs, ...suffix.reverse()], capped: true };
  }

  return { pairs: [...pairs, ...middle, ...suffix.reverse()], capped: false };
}

/**
 * Run the greedy forward search over `a[aStart, aEnd)` and `b[bStart, bEnd)`, keeping one
 * frontier snapshot per edit distance so the path can be walked back. Returns `null` past `maxCost`.
 */
function searchMiddle(
  a: readonly string[],
  b: readonly string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  maxCost: number,
): Array<[number, number]> | null {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  if (n === 0 || m === 0) {
    return [];
  }

  const max = Math.min(n + m, maxCost);
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(frontier.slice(offset - d - 1, offset + d + 2));

    for (let k = -d; k <= d; k += 2) {
      // Prefer moving down (an insertion from b) only when it reaches further; otherwise move
      // right (a deletion from a). This is the deterministic "delete first" tie-break.
      const down = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!);
      let x = down ? frontier[offset + k + 1]! : frontier[offset + k - 1]! + 1;
      let y = x - k;

      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x += 1;
        y += 1;
      }

      frontier[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, d, n, m, aStart, bStart);
      }
    }
  }

  return null;
}

/** Walk the stored frontiers from the end back to the origin, collecting the diagonal matches. */
function backtrack(trace: Int32Array[], finalD: number, n: number, m: number, aStart: number, bStart: number) {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;

  for (let d = finalD; d > 0; d--) {
    const snapshot = trace[d]!;
    // Snapshot index for diagonal k at distance d is k + d + 1.
    const at = (k: number) => snapshot[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    const startY = startX - k;

    while (x > startX && y > startY) {
      x -= 1;
      y -= 1;
      pairs.push([aStart + x, bStart + y]);
    }

    x = prevX;
    y = prevY;
  }

  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    pairs.push([aStart + x, bStart + y]);
  }

  return pairs.reverse();
}
