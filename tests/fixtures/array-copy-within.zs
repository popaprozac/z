struct Pair {
  left: i32;
  right: u8;
}

enum Mode {
  idle,
  busy,
}

struct Strip {
  bytes: Array<u8>;

  // A live run slid down over a dead one, as a compaction moves it.
  function slide(inout this, source: usize, destination: usize, count: usize): void {
    this.bytes.copyWithin(destination, source, source + count);
  }
}

type Bytes = Array<u8>;

function moveWithin<T>(inout values: Array<T>, target: usize, start: usize, end: usize): void {
  values.copyWithin(target, start, end);
}

function numbered(length: usize): Array<u32> {
  let values = Array<u32>();
  let index: usize = 0;
  while (index < length) {
    values.push(u32(index) * 3 + 1);
    index = index + 1;
  }
  return values;
}

// What copyWithin(target, start, end) leaves, element by element through a
// copy of the run.
function expected(values: Slice<u32>, target: usize, start: usize, end: usize): Array<u32> {
  let result = Array<u32>();
  result.append(values);
  let run = Array<u32>();
  let index = start;
  while (index < end) {
    run.push(values[index]);
    index = index + 1;
  }
  index = 0;
  while (index < run.length) {
    result[target + index] = run[index];
    index = index + 1;
  }
  return result;
}

function same(left: Slice<u32>, right: Slice<u32>): boolean {
  if (left.length != right.length) return false;
  let index: usize = 0;
  while (index < left.length) {
    if (left[index] != right[index]) return false;
    index = index + 1;
  }
  return true;
}

function main(): i32 {
  // Every run length across the inline and memmove forms, moved down, up,
  // and onto itself, overlapping and not.
  let count: usize = 0;
  while (count <= 40) {
    let shift: usize = 0;
    while (shift <= 3) {
      let down = numbered(count + 8);
      const wantDown = expected(down, 4 - shift, 4, 4 + count);
      down.copyWithin(4 - shift, 4, 4 + count);
      if (!same(down, wantDown)) return 1;
      let up = numbered(count + 8);
      const wantUp = expected(up, 4 + shift, 4, 4 + count);
      up.copyWithin(4 + shift, 4, 4 + count);
      if (!same(up, wantUp)) return 2;
      shift = shift + 1;
    }
    let apart = numbered(2 * count + 8);
    const wantApart = expected(apart, count + 8, 0, count);
    apart.copyWithin(count + 8, 0, count);
    if (!same(apart, wantApart)) return 3;
    count = count + 1;
  }

  // Empty runs, at the end and in an Array that has no storage yet.
  let empty = Array<u8>();
  empty.copyWithin(0, 0, 0);
  let three = Array<u8>(1, 2, 3);
  three.copyWithin(3, 3, 3);
  three.copyWithin(0, 1, 1);
  if (empty.length != 0 || three.length != 3 || three[0] != 1 || three[2] != 3) return 4;

  // Through a field, an alias, and a generic function, over bytes, words,
  // structs, and enums.
  let arena = Strip({ bytes: Array<u8>(9, 9, 9, 5, 6, 7, 8) });
  arena.slide(3, 0, 4);
  if (arena.bytes.length != 7 || arena.bytes[0] != 5 || arena.bytes[3] != 8 || arena.bytes[4] != 6) return 5;
  let bytes: Bytes = Array<u8>(1, 2, 3, 4, 5);
  bytes.copyWithin(1, 0, 4);
  if (bytes[0] != 1 || bytes[1] != 1 || bytes[2] != 2 || bytes[4] != 4) return 6;
  let words = Array<u64>(10, 20, 30, 40);
  moveWithin(inout words, 0, 2, 4);
  if (words[0] != 30 || words[1] != 40 || words[2] != 30) return 7;
  let pairs = Array<Pair>(Pair({ left: 1, right: 2 }), Pair({ left: 3, right: 4 }));
  moveWithin(inout pairs, 1, 0, 1);
  if (pairs[1].left != 1 || pairs[1].right != 2 || pairs[0].left != 1) return 8;
  let modes = Array<Mode>(Mode.idle, Mode.busy, Mode.idle);
  modes.copyWithin(0, 1, 2);
  if (modes[0] != Mode.busy || modes[1] != Mode.busy) return 9;
  return 0;
}
