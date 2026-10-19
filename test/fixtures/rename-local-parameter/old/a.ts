export function total(items: number[]) {
  let sum = 0;
  for (const n of items) sum += n;
  return sum;
}
