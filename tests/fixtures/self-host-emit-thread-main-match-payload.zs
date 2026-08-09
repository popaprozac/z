import { delay } from "std/time";
import { thread } from "std/thread";

struct Adjustment {
  amount: i32;
}

enum Route {
  publish i32,
  adjust Adjustment,
  idle,
}

function chooseRoute(route: Route): Route {
  return route;
}

async function publish(base: i32, route: Route): i32 on thread.main {
  match (chooseRoute(route)) {
    publish(value) => {
      let result = base + value;
      await delay(1);
      result = result + 1;
      return result;
    }
    adjust(adjustment) => {
      await delay(1);
      return base + adjustment.amount;
    }
    idle => {
      await delay(1);
      return base;
    }
  }
}

async function main(): i32 on thread.main {
  const publishedTask = thread.spawn(async (): i32 => {
    return await on thread.main publish(20, Route.publish(21));
  });
  const adjustedTask = thread.spawn(async (): i32 => {
    return await on thread.main publish(
      40,
      Route.adjust(Adjustment({ amount: 2 }))
    );
  });
  const idleTask = thread.spawn(async (): i32 => {
    return await on thread.main publish(42, Route.idle);
  });
  const published = await publishedTask;
  const adjusted = await adjustedTask;
  const idle = await idleTask;
  return published == 42 && adjusted == 42 && idle == 42 ? 0 : 1;
}
