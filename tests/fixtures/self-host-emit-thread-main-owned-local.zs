import { delay } from "std/time";
import { thread } from "std/thread";

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(value: String): String on thread.main {
  const staged = duplicate(value);
  await delay(1);
  const completed = move staged;
  await delay(1);
  return move completed;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): String => {
    const input = duplicate("owned frame");
    return await on thread.main publish(move input);
  });
  const result = await worker;
  return result == "owned frame" ? 0 : 1;
}
