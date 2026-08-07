import { thread } from "std/thread";

function publish(value: i32): i32 on thread.main {
  return value + 2;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish(40);
  });
  const value = await worker;
  return value - 42;
}
