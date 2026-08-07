import { delay } from "std/time";
import { thread } from "std/thread";

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(value: String): String on thread.main {
  await delay(1);
  return value;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): String => {
    const payload = duplicate("owned main result");
    return await on thread.main publish(move payload);
  });
  const value = await worker;
  return i32(value.byteLength) - 17;
}
