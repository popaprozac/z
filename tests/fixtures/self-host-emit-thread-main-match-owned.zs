import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct BranchResource {
  id: i32;

  deinit {
    console.log(`released match branch ${this.id}`);
  }
}

enum Route {
  release,
  idle,
}

async function publish(value: i32, route: Route): i32 on thread.main {
  match (route) {
    release => {
      const resource = BranchResource({ id: value });
      await delay(1);
      return resource.id;
    }
    idle => {
      await delay(1);
      return 0;
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish(42, Route.release);
  });
  const result = await worker;
  return result == 42 ? 0 : 1;
}
