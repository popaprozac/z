import console from "std/console";
import { delay, sleep } from "std/time";
import { thread } from "std/thread";

struct Calculation {
  value: i32;
  multiplier: i32;
}

function calculate(input: Calculation): i32 {
  sleep(25);
  return input.value * input.multiplier;
}

async function reportExecutorProgress(): void {
  await delay(1);
  console.log("FIFO executor progressed while native worker ran");
}

async function main(): i32 {
  const input = Calculation({ value: 21, multiplier: 2 });
  const calculation = thread.spawn(move () => calculate(input));
  const progress = task reportExecutorProgress();

  console.log("main task continued after thread.spawn");

  const answer = await calculation;
  await progress;
  console.log(`thread answer=${answer}`);
  return answer - 42;
}
