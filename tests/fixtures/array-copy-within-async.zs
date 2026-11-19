import { scheduler } from "std/async";

struct Pair {
  left: i32;
  right: i32;
}

async function main(): i32 {
  let bytes = Array<u8>(1, 2, 3, 4, 5, 6);
  await scheduler.yield();
  bytes.copyWithin(0, 2, 6);
  await scheduler.yield();
  if (bytes.length != 6 || bytes[0] != 3 || bytes[3] != 6 || bytes[4] != 5) return 1;
  let start: usize = 0;
  const end = bytes.length - 1;
  bytes.copyWithin(1, start, end);
  await scheduler.yield();
  if (bytes[0] != 3 || bytes[1] != 3 || bytes[2] != 4 || bytes[5] != 5) return 2;
  let pairs = Array<Pair>(Pair({ left: 20, right: 22 }), Pair({ left: 0, right: 0 }));
  pairs.copyWithin(1, 0, 1);
  await scheduler.yield();
  if (pairs[1].left + pairs[1].right != 42) return 3;
  return 0;
}
