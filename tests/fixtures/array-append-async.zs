import { scheduler } from "std/async";

struct Pair {
  left: i32;
  right: i32;
}

async function main(): i32 {
  let bytes = Array<u8>(1);
  const more = Array<u8>(2, 3);
  await scheduler.yield();
  bytes.append(more);
  const fixed = Array<u8>(4, 5);
  bytes.append(fixed);
  await scheduler.yield();
  if (bytes.length != 5 || bytes[2] != 3 || bytes[4] != 5) return 1;
  let numbers = Array<i32>(1);
  const others = Array<i32>(2, 3);
  numbers.append(others);
  await scheduler.yield();
  if (numbers.length != 3 || numbers[2] != 3) return 3;
  let pairs = Array<Pair>();
  const incoming = Array<Pair>(Pair({ left: 20, right: 22 }));
  pairs.append(incoming);
  await scheduler.yield();
  if (pairs.length != 1 || pairs[0].left + pairs[0].right != 42) return 2;
  return 0;
}
