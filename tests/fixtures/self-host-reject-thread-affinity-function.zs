import { thread } from "std/thread";

function publishedValue(): i32 on thread.main {
  return 42;
}

async function main(): i32 on thread.main {
  const job = thread.spawn(
    move (): i32 => publishedValue()
  );
  return await job;
}
