// A dedicated worker owns the cancellable waits and loop repetition while
// each condition check and synchronous publication segment executes on main.

import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

async function publishProgress(stepCount: i32): i32 on thread.main {
  let completed = 0;
  while (completed < stepCount) {
    completed = completed + 1;
    await delay(10);
    console.log(`published progress ${completed}/${stepCount} on main`);
  }
  return completed;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publishProgress(3);
  });
  const completed = await worker;
  return completed == 3 ? 0 : 1;
}
