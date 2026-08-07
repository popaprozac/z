import { delay } from "std/time";
import { thread } from "std/thread";

async function publish(value: i32): i32 on thread.main {
  let staged = value + 1;
  await delay(1);
  staged = staged + 1;
  const completed = staged;
  await delay(1);
  return completed;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish(40);
  });
  const result = await worker;
  return result == 42 ? 0 : 1;
}
