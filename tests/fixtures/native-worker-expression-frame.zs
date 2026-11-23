import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";

// An expression-bodied worker's await belongs to the worker, also when the
// function that spawns it suspends in a frame of its own.

async function report(base: i32): i32 {
  await delay(1);
  console.log(`ran ${base}`);
  return base + 1;
}

async function main(): i32 {
  const worker = thread.spawn(async () => await report(5));
  const value = await worker;
  console.log(`joined ${value}`);
  const job = task on thread.main: i32 {
    select value + 1;
  };
  const jobValue = await job;
  console.log(`job ${jobValue}`);
  return 0;
}
