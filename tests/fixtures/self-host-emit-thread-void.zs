import { thread } from "std/thread";

async function main(): i32 {
  const worker = thread.spawn((): void => {
    const answer = 42;
  });
  await worker;
  return 0;
}
