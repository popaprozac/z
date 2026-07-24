// Executor placement runs blocks synchronously, awaited, or as structured tasks
// on the main executor.

import { thread } from "std/thread";

async function main(): i32 {
  const immediate = on thread.main: i32 {
    select 1;
  };

  const hopped = await on thread.main: i32 {
    select 20;
  };

  const placedTask = task on thread.main: i32 {
    select 21;
  };
  const placed = await placedTask;

  return immediate + hopped + placed - 42;
}
