import { thread } from "std/thread";

type AsyncHandler =
  async (in value: i32) => i32 on thread.any;

async function main(): i32 {
  const offset = 1;
  const handler: AsyncHandler =
    async move (in value) => value + offset;
  const input = 41;
  return await handler(in input) - 42;
}
