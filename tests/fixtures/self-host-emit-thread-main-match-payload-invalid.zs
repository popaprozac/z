import { delay } from "std/time";
import { thread } from "std/thread";

enum Route {
  publish String,
  idle,
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(in route: Route): i32 on thread.main {
  match (in route) {
    publish(value) => {
      await delay(1);
      return value.byteLength == 7 ? 7 : 0;
    }
    idle => {
      return 0;
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    const route = Route.publish(duplicate("payload"));
    return await on thread.main publish(in route);
  });
  return await worker - 7;
}
