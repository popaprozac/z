import { delay } from "std/time";
import { thread } from "std/thread";

enum Route {
  publish String,
  idle,
}

function identity(route: Route): Route {
  return route;
}

async function publish(route: Route): i32 on thread.main {
  match (identity(route)) {
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
  return 0;
}
