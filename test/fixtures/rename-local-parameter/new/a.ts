export function total(values: number[]) {
  let sum = 0;
  for (const n of values) sum += n;
  return sum;
}
