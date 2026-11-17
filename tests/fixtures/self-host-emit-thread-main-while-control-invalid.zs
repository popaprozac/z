import { delay } from "std/time";
import { thread } from "std/thread";

struct Marker {
  label: String;
}

// The owned loop local keeps `publish` on the worker-to-main bridge, whose
// synchronous while segments must end explicitly.
async function publish(limit: i32): i32 on thread.main {
  let current = 0;
  while (current < limit) {
    const marker = Marker({ label: "iteration" });
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
