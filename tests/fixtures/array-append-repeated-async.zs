import { scheduler } from "std/async";

struct Pair {
  left: i32;
  right: i32;
}

async function main(): i32 {
  let bytes = Array<u8>(1);
  await scheduler.yield();
  bytes.appendRepeated(7, 3);
  await scheduler.yield();
  if (bytes.length != 4 || bytes[0] != 1 || bytes[3] != 7) return 1;
  let count: usize = 20;
  const last = bytes[3];
  bytes.appendRepeated(last, count);
  await scheduler.yield();
  if (bytes.length != 24 || bytes[23] != 7) return 2;
  let pairs = Array<Pair>();
  pairs.appendRepeated(Pair({ left: 20, right: 22 }), 2);
  await scheduler.yield();
  if (pairs.length != 2 || pairs[1].left + pairs[1].right != 42) return 3;
  return 0;
}
