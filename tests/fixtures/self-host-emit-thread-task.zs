import { thread } from "std/thread";

function calculate(): i32 {
  return 40;
}

async function main(): i32 {
  const adjustment: i32 = 2;
  const worker = thread.spawn(move (): i32 => {
    const base = calculate();
    return base + adjustment;
  });
  const answer = await worker;
  return answer - 42;
}
