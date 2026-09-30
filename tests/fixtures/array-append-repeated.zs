struct Pair {
  left: i32;
  right: u8;
}

enum Mode {
  idle,
  busy,
}

struct Store {
  slots: Array<u64>;
  rows: Array<Array<u8>>;
  cells: usize;

  function allocate(inout this, count: usize): usize {
    const start = this.slots.length;
    this.slots.appendRepeated(7, count);
    this.cells = this.cells + 1;
    return start;
  }

  function widen(inout this, row: usize, width: usize): void {
    if (this.rows[row].length < width) this.rows[row].appendRepeated(9, width - this.rows[row].length);
  }
}

type Bytes = Array<u8>;

function fill<T>(inout target: Array<T>, value: T, count: usize): void {
  target.appendRepeated(value, count);
}

function allEqual(values: Slice<u32>, start: usize, expected: u32): boolean {
  let index = start;
  while (index < values.length) {
    if (values[index] != expected) return false;
    index = index + 1;
  }
  return true;
}

function main(): i32 {
  let numbers = Array<u32>();
  numbers.appendRepeated(5, 0);
  if (numbers.length != 0) return 1;
  numbers.appendRepeated(5, 1);
  if (numbers.length != 1 || numbers[0] != 5) return 2;

  // Every count across the short and long forms keeps what was there and
  // stores exactly the run.
  let count: usize = 0;
  while (count <= 40) {
    let run = Array<u32>(1, 2);
    run.appendRepeated(u32(count) + 10, count);
    if (run.length != count + 2 || run[0] != 1 || run[1] != 2) return 3;
    if (!allEqual(run, 2, u32(count) + 10)) return 4;
    count = count + 1;
  }

  let exact = Array<u32>.withCapacity(64);
  exact.appendRepeated(3, 64);
  if (exact.capacity != 64 || exact.length != 64 || exact[63] != 3) return 5;
  exact.appendRepeated(4, 1000);
  if (exact.length != 1064 || exact[63] != 3 || exact[64] != 4 || exact[1063] != 4) return 6;

  let pairs = Array<Pair>();
  pairs.appendRepeated(Pair({ left: 20, right: 2 }), 3);
  pairs.appendRepeated(Pair({ left: 1, right: 1 }), 20);
  if (pairs.length != 23 || pairs[0].left + pairs[2].left != 40 || pairs[2].right != 2 || pairs[22].left != 1) return 7;

  let modes = Array<Mode>();
  modes.appendRepeated(Mode.busy, 5);
  if (modes.length != 5 || modes[4] != Mode.busy) return 8;

  let flags = Array<boolean>();
  flags.appendRepeated(true, 17);
  if (flags.length != 17 || !flags[16]) return 9;

  let reals = Array<f64>();
  reals.appendRepeated(1.5, 4);
  if (reals.length != 4 || reals[3] != 1.5) return 10;

  let echo = Array<u32>(42);
  const head = echo[0];
  echo.appendRepeated(head, 3);
  if (echo.length != 4 || echo[3] != 42) return 11;

  let arena = Store({ slots: Array<u64>(), rows: Array<Array<u8>>(), cells: 0 });
  const first = arena.allocate(4);
  const second = arena.allocate(30);
  if (first != 0 || second != 4 || arena.slots.length != 34 || arena.slots[33] != 7 || arena.cells != 2) return 12;
  arena.rows.push(Array<u8>(1));
  arena.rows.push(Array<u8>());
  arena.widen(0, 5);
  arena.widen(0, 3);
  arena.widen(1, 2);
  if (arena.rows[0].length != 5 || arena.rows[0][0] != 1 || arena.rows[0][4] != 9 || arena.rows[1].length != 2) return 13;

  let bytes: Bytes = Bytes.withCapacity(0);
  const letter: u8 = 65;
  fill(inout bytes, letter, 3);
  if (bytes.length != 3 || bytes[2] != 65) return 14;
  let wide = Array<i64>();
  const minus: i64 = -1;
  fill(inout wide, minus, 18);
  if (wide.length != 18 || wide[17] != -1) return 15;
  return 0;
}
