import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

async function publish(value: i32): i32 on thread.main {
  console.log(`main segment 1: ${value}`);
  await delay(1);
  console.log(`main segment 2: ${value}`);
  await delay(1);
  return value;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish(0);
  });
  return await worker;
}
