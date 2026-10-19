import { describe, expect, test } from "bun:test";
import { myersDiff } from "./myers";

/** Length of a longest common subsequence by dynamic programming, the reference for minimality. */
function lcsLength(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i]![j] = a[i - 1] === b[j - 1] ? table[i - 1]![j - 1]! + 1 : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }

  return table[a.length]![b.length]!;
}

/** Small seeded PRNG so the property test is reproducible. */
function testRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Check that pairs are increasing and actually match. */
function expectValidPairs(a: string[], b: string[], pairs: Array<[number, number]>) {
  let lastI = -1;
  let lastJ = -1;
  for (const [i, j] of pairs) {
    expect(i).toBeGreaterThan(lastI);
    expect(j).toBeGreaterThan(lastJ);
    expect(a[i]).toBe(b[j]!);
    lastI = i;
    lastJ = j;
  }
}

describe("myersDiff", () => {
  test("handles empty and identical inputs", () => {
    expect(myersDiff([], []).pairs).toEqual([]);
    expect(myersDiff(["a"], []).pairs).toEqual([]);
    expect(myersDiff([], ["a"]).pairs).toEqual([]);
    expect(myersDiff(["a", "b"], ["a", "b"]).pairs).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  test("finds the classic ABCABBA / CBABAC alignment of length 4", () => {
    const a = [..."ABCABBA"];
    const b = [..."CBABAC"];
    const { pairs } = myersDiff(a, b);
    expectValidPairs(a, b, pairs);
    expect(pairs.length).toBe(4);
  });

  test("full replacement matches nothing", () => {
    expect(myersDiff(["a", "b"], ["c", "d"]).pairs).toEqual([]);
  });

  test("is minimal and valid on random inputs", () => {
    const random = testRandom(7);
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: Math.floor(random() * 14) }, () => "abc"[Math.floor(random() * 3)]!);
      const b = Array.from({ length: Math.floor(random() * 14) }, () => "abc"[Math.floor(random() * 3)]!);
      const { pairs, capped } = myersDiff(a, b);
      expect(capped).toBe(false);
      expectValidPairs(a, b, pairs);
      expect(pairs.length).toBe(lcsLength(a, b));
    }
  });

  test("is deterministic", () => {
    const a = [..."xaybzc"];
    const b = [..."abcxyz"];
    expect(myersDiff(a, b)).toEqual(myersDiff(a, b));
  });

  test("reports capped when the edit distance exceeds maxCost, keeping prefix and suffix", () => {
    const a = ["p", "1", "2", "3", "4", "s"];
    const b = ["p", "5", "6", "7", "8", "s"];
    const result = myersDiff(a, b, { maxCost: 3 });
    expect(result.capped).toBe(true);
    expect(result.pairs).toEqual([
      [0, 0],
      [5, 5],
    ]);
  });
});
