import { delay } from "std/time";
import { thread } from "std/thread";

enum Route {
  publish String,
  idle,
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(): String on thread.main {
  match (Route.publish(duplicate("computed constructor"))) {
    publish(value) => {
      const before = value.byteLength;
      await delay(1);
      if (value.byteLength != before) return duplicate("invalid");
      return value;
    }
    idle => {
      return duplicate("idle");
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): String => {
    return await on thread.main publish();
  });
  const result = await worker;
  return result == "computed constructor" ? 0 : 1;
}
