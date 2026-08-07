import { thread } from "std/thread";

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function main(): i32 {
  const source = duplicate("cancelled result");
  const worker = thread.spawn(move (): String => move source);
  await worker.cancel();
  return 0;
}
