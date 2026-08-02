import { thread } from "std/thread";

async function main(): i32 {
  const message = "owned worker value";
  const worker = thread.spawn(
    move (): i32 => i32(message.byteLength)
  );
  return await worker;
}
