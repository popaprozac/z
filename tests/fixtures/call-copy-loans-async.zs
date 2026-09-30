import { scheduler } from "std/async";

struct Tally {
  total: u32;
  items: Array<u32>;

  function add(inout this, value: u32): u32 {
    this.total = this.total + 100;
    this.items.push(value);
    return value;
  }
}

async function main(): i32 {
  let values = Array<u32>(42);
  await scheduler.yield();
  values.push(values[0]);
  values.appendRepeated(values[1], values.length);
  await scheduler.yield();
  if (values.length != 4 || values[3] != 42) return 1;
  let tally = Tally({ total: 1, items: Array<u32>() });
  await scheduler.yield();
  if (tally.add(tally.total) != 1 || tally.total != 101) return 2;
  await scheduler.yield();
  if (tally.items.length != 1 || tally.items[0] != 1) return 3;
  return 0;
}
