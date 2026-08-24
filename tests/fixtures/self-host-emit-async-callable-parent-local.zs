import { scheduler } from "std/async";
import { thread } from "std/thread";

type AsyncAction =
  async (value: i32) => void on thread.any;

async function main(): i32 {
  const baseline = 42;
  const action: AsyncAction =
    async (value: i32) => await scheduler.yield();
  await action(baseline);
  return baseline - 42;
}
