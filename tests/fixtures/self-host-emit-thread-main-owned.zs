import { thread } from "std/thread";

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

function publish(value: String): String on thread.main {
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
