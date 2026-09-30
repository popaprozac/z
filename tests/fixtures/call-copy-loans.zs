import { Map, Set } from "std/collections";

struct Pair {
  left: u32;
  right: u32;
}

struct Holder {
  pair: Pair;
  grid: u32[4];
  spare: Option<u32>;
  total: u32;
  items: Array<u32>;

  // Each method changes the storage its argument was copied from, then
  // reads the argument: the copy was made before the call began.
  function replacePair(inout this, pair: Pair): u32 {
    this.pair.left = 100;
    this.pair.right = 200;
    return pair.left + pair.right;
  }

  function replaceGrid(inout this, grid: u32[4]): u32 {
    this.grid[0] = 50;
    this.grid[3] = 60;
    return grid[0] + grid[3];
  }

  function clearSpare(inout this, spare: Option<u32>): u32 {
    this.spare = Option.none;
    match (spare) {
      some(value) => return value;
      none => {}
    }
    return 0;
  }

  function grow(inout this, value: u32): u32 {
    let round = 0;
    while (round < 64) {
      this.items.push(9);
      round = round + 1;
    }
    this.total = 0;
    return value;
  }
}

struct Wrap<T> {
  item: T;

  function put(inout this, value: T): T {
    const before = this.item;
    this.item = value;
    return before;
  }
}

class Counter {
  count: u32;
  log: Array<u32>;

  function bump(inout this, by: u32): u32 {
    this.count = this.count + 10;
    return by;
  }
}

function raise(inout holder: Holder, by: u32): u32 {
  holder.total = holder.total + 1000;
  return by;
}

function lower(by: u32, inout holder: Holder): u32 {
  holder.total = 0;
  return by;
}

function inspect(in holder: Holder, total: u32): u32 {
  return holder.total + total;
}

function store<T>(inout target: Array<T>, value: T): void {
  target.push(value);
}

function main(): i32 {
  // Built-in mutators read their own receiver by value.
  let values = Array<u32>(42);
  values.push(values[0]);
  values.push(values[0]);
  values.push(values[1]);
  if (values.length != 4 || values[3] != 42) return 1;
  let sizes = Array<usize>();
  sizes.push(sizes.length);
  sizes.push(sizes.length);
  sizes.push(sizes.capacity);
  if (sizes.length != 3 || sizes[0] != 0 || sizes[1] != 1 || sizes[2] < 2) return 2;
  sizes.reserveCapacity(sizes[1]);
  values.appendRepeated(values[0], values.length);
  if (values.length != 8 || values[7] != 42) return 3;
  let pairs = Array<Pair>(Pair({ left: 1, right: 2 }));
  pairs.push(pairs[0]);
  if (pairs.length != 2 || pairs[1].left + pairs[1].right != 3) return 4;
  let lengths = Map<u32, usize>();
  lengths.set(1, lengths.length);
  lengths.set(2, lengths.length);
  let seen = Set<usize>();
  seen.add(seen.length);
  seen.add(seen.length);
  if (lengths.length != 2 || seen.length != 2 || !seen.has(1)) return 5;

  // Methods and functions declared in Z do too.
  let holder = Holder({
    pair: Pair({ left: 1, right: 2 }),
    grid: [u32(3), 0, 0, 4],
    spare: Option.some(5),
    total: 6,
    items: Array<u32>(7),
  });
  if (holder.replacePair(holder.pair) != 3 || holder.pair.left != 100) return 6;
  if (holder.replaceGrid(holder.grid) != 7 || holder.grid[0] != 50) return 7;
  if (holder.clearSpare(holder.spare) != 5) return 8;
  if (holder.grow(holder.items[0]) != 7 || holder.items.length != 65) return 9;
  holder.total = 6;
  if (raise(inout holder, holder.total) != 6 || holder.total != 1006) return 10;
  if (lower(holder.total, inout holder) != 1006 || holder.total != 0) return 11;
  holder.total = 6;
  if (inspect(holder, holder.total) != 12) return 12;

  let wrap = Wrap<u32>({ item: 8 });
  if (wrap.put(wrap.item) != 8) return 13;
  let numbers = Array<u32>(11);
  store(inout numbers, numbers[0]);
  if (numbers.length != 2 || numbers[1] != 11) return 14;

  // A copied field of a class instance is a copy like any other.
  let counter = new Counter({ count: 1, log: Array<u32>() });
  if (counter.bump(counter.count) != 1 || counter.count != 11) return 15;
  counter.log.push(counter.count);
  if (counter.log.length != 1 || counter.log[0] != 11) return 16;
  return 0;
}
