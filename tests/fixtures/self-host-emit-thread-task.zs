import { thread } from "std/thread";

function calculate(): i32 {
  return 40;
}

async function main(): i32 {
  const worker = thread.spawn((): i32 => {
    const base = calculate();
    return base + 2;
  });
  const answer = await worker;
  return answer - 42;
}
