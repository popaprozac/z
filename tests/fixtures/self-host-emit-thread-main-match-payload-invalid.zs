import { delay } from "std/time";
import { thread } from "std/thread";

enum Route {
  publish String,
  idle,
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(route: Route): usize on thread.main {
  match (route) {
    publish(value) => {
      await delay(1);
      return value.byteLength;
    }
    idle => {
      return 0;
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): usize => {
    return await on thread.main publish(Route.publish(duplicate("payload")));
  });
  const length = await worker;
  return i32(length) - 7;
}
