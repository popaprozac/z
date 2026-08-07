import { delay } from "std/time";
import { thread } from "std/thread";

async function publish(value: i32): i32 on thread.main {
  const staged = value + 1;
  await delay(1);
  return staged + 1;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish(40);
  });
  return await worker;
}
