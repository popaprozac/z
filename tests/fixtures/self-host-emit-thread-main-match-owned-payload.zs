import { delay } from "std/time";
import { thread } from "std/thread";

enum Route {
  publish String,
  idle,
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(route: Route): String on thread.main {
  match (route) {
    publish(value) => {
      const before = value.byteLength;
      await delay(1);
      if (value.byteLength != before) return duplicate("invalid");
      return value;
    }
    idle => {
      await delay(1);
      return duplicate("idle");
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): String => {
    const payload = duplicate("owned match payload");
    const route = Route.publish(move payload);
    return await on thread.main publish(move route);
  });
  const result = await worker;
  return result == "owned match payload" ? 0 : 1;
}
