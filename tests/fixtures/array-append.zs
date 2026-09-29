import embed from "std/embed";

const DATA: embed.StaticBytes = embed.bytes("./array-append-data.txt");

struct Pair {
  left: i32;
  right: u8;
}

enum Mode {
  idle,
  busy,
}

struct Builder {
  bytes: Array<u8>;
  count: usize;

  function add(inout this, items: Slice<u8>): void {
    this.bytes.append(items);
    this.count = this.count + items.length;
  }
}

type Bytes = Array<u8>;

function appendAll<T>(inout target: Array<T>, items: Slice<T>): void {
  target.append(items);
}

function tail(values: Slice<u8>): u8 {
  return values[values.length - 1];
}

function main(): i32 {
  let bytes = Array<u8>();
  const empty = Array<u8>();
  bytes.append(empty);
  if (bytes.length != 0) return 1;
  const fixed = Array<u8>(1, 2, 3);
  bytes.append(fixed);
  if (bytes.length != 3 || bytes[0] != 1 || bytes[2] != 3) return 2;
  let more = Array<u8>(4, 5);
  let round = 0;
  while (round < 100) {
    bytes.append(more);
    round = round + 1;
  }
  if (bytes.length != 203 || bytes[3] != 4 || bytes[202] != 5 || tail(bytes) != 5) return 3;
  more.push(6);
  if (more.length != 3 || bytes.length != 203) return 4;

  let exact = Array<u8>.withCapacity(8);
  exact.append(fixed);
  if (exact.capacity < 8 || exact.length != 3) return 5;

  let pairs = Array<Pair>(Pair({ left: -1, right: 1 }));
  const incoming = Array<Pair>(Pair({ left: 20, right: 2 }), Pair({ left: 22, right: 3 }));
  pairs.append(incoming);
  if (pairs.length != 3 || pairs[1].left + pairs[2].left != 42 || pairs[2].right != 3) return 6;

  let modes = Array<Mode>();
  const pending: Mode[2] = [Mode.busy, Mode.idle];
  modes.append(pending);
  if (modes.length != 2 || modes[0] != Mode.busy || modes[1] != Mode.idle) return 7;

  let rows = Array<i32[2]>();
  const grid: i32[2][2] = [[1, 2], [3, 4]];
  rows.append(grid);
  if (rows.length != 2 || rows[1][0] != 3) return 8;

  let builder = Builder({ bytes: Array<u8>(), count: 0 });
  builder.add(fixed);
  builder.add(bytes);
  if (builder.bytes.length != 206 || builder.count != 206 || builder.bytes[205] != 5) return 9;

  let numbers = Array<i32>(1);
  const others = Array<i32>(2, 3);
  appendAll(inout numbers, others);
  const literal = [4, 5];
  numbers.append(literal);
  if (numbers.length != 5 || numbers[2] != 3 || numbers[4] != 5) return 10;

  let aliased = Bytes.withCapacity(0);
  aliased.append(fixed);
  if (aliased.length != 3) return 11;
  aliased.append(DATA);
  if (aliased.length != 5 || aliased[3] != 90 || aliased[4] != 33) return 12;
  return 0;
}
