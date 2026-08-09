import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct ReturnResource {
  id: i32;

  deinit {
    console.log(`released return iteration ${this.id}`);
  }
}

async function selectValue(
  limit: i32,
  beforeWait: boolean
): i32 on thread.main {
  let current = 0;
  while (current < limit) {
    current = current + 1;
    const resource = ReturnResource({ id: current });
    if (beforeWait && current == 1) return 41;
    await delay(1);
    if (!beforeWait && current == 2) return current + 40;
  }
  return 0;
}

async function main(): i32 on thread.main {
  const immediateWorker = thread.spawn(async (): i32 => {
    return await on thread.main selectValue(4, true);
  });
  const immediate = await immediateWorker;
  const delayedWorker = thread.spawn(async (): i32 => {
    return await on thread.main selectValue(4, false);
  });
  const delayed = await delayedWorker;
  return immediate + delayed == 83 ? 0 : 1;
}
