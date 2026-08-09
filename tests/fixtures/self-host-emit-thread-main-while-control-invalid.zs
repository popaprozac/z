import { delay } from "std/time";
import { thread } from "std/thread";

async function publish(limit: i32): i32 on thread.main {
  let current = 0;
  while (current < limit) {
    if (current == 1) continue;
    current = current + 1;
    await delay(1);
  }
  return current;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish(2);
  });
  return await worker;
}
