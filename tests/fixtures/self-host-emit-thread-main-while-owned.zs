import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct IterationResource {
  id: i32;

  deinit {
    console.log(`released iteration ${this.id}`);
  }
}

async function accumulate(limit: i32): i32 on thread.main {
  let current = 0;
  let total = 0;
  while (current < limit) {
    current = current + 1;
    const resource = IterationResource({ id: current });
    if (current == 2) continue;
    await delay(1);
    total = total + resource.id;
    if (current == 4) break;
  }
  return total;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main accumulate(8);
  });
  const total = await worker;
  return total == 8 ? 0 : 1;
}
