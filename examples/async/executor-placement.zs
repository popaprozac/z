// Executor placement runs direct calls or multi-statement blocks as awaited
// work or structured tasks on the main executor.

import { thread } from "std/thread";

function readStatus(value: i32): i32 {
  return value;
}

async function loadStatus(value: i32): i32 {
  return value;
}

async function main(): i32 {
  const hopped = await on thread.main readStatus(20);

  const placedTask = task on thread.main loadStatus(21);
  const placed = await placedTask;

  return hopped + placed - 41;
}
