enum Mode {
  idle,
  busy,
}

function total(values: Slice<u8>): u32 {
  let sum: u32 = 0;
  for (const value of values) { sum = sum + u32(value); }
  return sum;
}

function main(): i32 {
  const fixed: u8[3] = [1, 2, 250];
  const grid: u16[2][2] = [[1, 2], [3, 65535]];
  const wide: i64[2] = [-9007199254740993, 4];
  const modes: Mode[2] = [Mode.busy, Mode.idle];
  let mutable: u8[2] = [0, 0];
  mutable = [9, 10];
  if (total(fixed) != 253 || grid[1][1] != 65535 || wide[0] != -9007199254740993) return 1;
  if (modes[0] != Mode.busy || mutable[1] != 10) return 2;
  return 0;
}
