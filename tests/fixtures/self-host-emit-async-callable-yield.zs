import { scheduler } from "std/async";
import { thread } from "std/thread";

type AsyncAction =
  async () => void on thread.any;

async function main(): i32 {
  const action: AsyncAction =
    async () => await scheduler.yield();
  await action();
  return 0;
}
