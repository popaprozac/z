import { delay } from "std/time";
import { thread } from "std/thread";

enum Route {
  publish i32,
  idle,
}

async function publish(route: Route): i32 on thread.main {
  match (route) {
    publish(value) => {
      await delay(1);
      return value;
    }
    idle => {
      return 0;
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish(Route.publish(42));
  });
  return await worker;
}
