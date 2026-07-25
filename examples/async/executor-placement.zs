// Executor placement runs blocks as awaited work or structured tasks on the
// main executor.

import { thread } from "std/thread";

async function main(): i32 {
  const hopped = await on thread.main: i32 {
    select 20;
  };

  const placedTask = task on thread.main: i32 {
    select 21;
  };
  const placed = await placedTask;

  return hopped + placed - 41;
}
