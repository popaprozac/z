import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct ComputedPayload {
  id: i32;

  deinit {
    console.log(`released computed match payload ${this.id}`);
  }
}

enum Route {
  publish ComputedPayload,
  idle,
}

function identity(route: Route): Route {
  return route;
}

async function publish(route: Route): i32 on thread.main {
  match (identity(route)) {
    publish(payload) => {
      const before = payload.id;
      await delay(1);
      return payload.id == before ? payload.id : 0;
    }
    idle => {
      return 0;
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    const payload = ComputedPayload({ id: 42 });
    const route = Route.publish(move payload);
    return await on thread.main publish(move route);
  });
  const result = await worker;
  return result == 42 ? 0 : 1;
}
