import { delay } from "std/time";
import { thread } from "std/thread";

async function publish(): i32 on thread.main {
  let staged: i32;
  await delay(1);
  staged = 42;
  return staged;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish();
  });
  return await worker;
}
