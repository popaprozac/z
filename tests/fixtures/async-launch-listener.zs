// Integration prerequisite: Stage 0 runs this; native Z reports Z0700 for
// the ordinary named suspending helper. No native resources are needed.
import { scheduler } from "std/async";

async function listen(): void {
  let count = 0;
  while (count < 2) {
    await scheduler.yield();
    count = count + 1;
  }
}

async function main(): i32 {
  await listen();
  return 0;
}
