import { thread } from "std/thread";

function consume(message: String): i32 {
  return i32(message.byteLength);
}

async function main(): i32 {
  const message = "owned worker value";
  const worker = thread.spawn(
    move (): i32 => consume(message)
  );
  return await worker;
}
