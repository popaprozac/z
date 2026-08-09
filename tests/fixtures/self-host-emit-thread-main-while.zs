import { delay } from "std/time";
import { thread } from "std/thread";

async function accumulate(limit: i32): i32 on thread.main {
  let current = 0;
  let total = 0;
  while (current < limit) {
    current = current + 1;
    await delay(1);
    total = total + current;
  }
  return total;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main accumulate(4);
  });
  const total = await worker;
  return total == 10 ? 0 : 1;
}
