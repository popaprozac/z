import { delay } from "std/time";
import { thread } from "std/thread";

async function publish(value: i32): i32 on thread.main {
  if (value > 0) {
    return value;
  }
  await delay(1);
  return value;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish(42);
  });
  return await worker;
}
