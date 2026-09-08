// Both compiler paths execute this ordinary named suspending helper.
// The real listener's native resources and child awaits are separate tiers.
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
