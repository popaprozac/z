// Executor placement runs direct calls or multi-statement blocks as awaited
// work or structured tasks on the main executor.

import { thread } from "std/thread";

struct Counter {
  value: i32;
}

function readStatus(value: i32): i32 {
  return value;
}

async function loadStatus(value: i32): i32 {
  return value;
}

async function main(): i32 {
  let counter = Counter({ value: 0 });
  let values = Array<i32>();
  values.push(1);

  const hopped = await on thread.main readStatus(20);

  const placedTask = task on thread.main loadStatus(21);
  const placed = await placedTask;

  const captured = await on thread.main using (inout counter, move values): i32 {
    counter.value = counter.value + values[0];
    select counter.value;
  };

  return hopped + placed + captured + counter.value - 43;
}
