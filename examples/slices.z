import stdio from "stdio.h";

function sum(values: Slice<i32>): i32 {
  let index: usize = 0;
  let total = 0;
  while (index < values.length) {
    total = total + values[index];
    index = index + 1;
  }
  return total;
}

function fill(inout values: Slice<i32>, value: i32): void {
  let index: usize = 0;
  while (index < values.length) {
    values[index] = value;
    index = index + 1;
  }
}

function main(): i32 {
  let values = [1, 2, 3, 4];
  const before = sum(values);
  fill(inout values, 7);
  const after = sum(values);
  stdio.printf("before=%d after=%d\n", before, after);
  return 0;
}
