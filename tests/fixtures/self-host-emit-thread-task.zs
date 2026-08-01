import { thread } from "std/thread";

async function main(): i32 {
  const worker = thread.spawn((): i32 => 42);
  const answer = await worker;
  return answer - 42;
}
