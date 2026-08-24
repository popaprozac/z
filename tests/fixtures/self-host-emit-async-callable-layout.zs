import { thread } from "std/thread";

type AsyncHandler =
  async (in value: i32) => i32 on thread.any;

struct HandlerSlot {
  handler: AsyncHandler;
}

function main(): i32 {
  return 0;
}
