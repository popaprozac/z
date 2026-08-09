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
  release BranchResource,
  idle,
}

async function publish(route: Route): i32 on thread.main {
  match (route) {
    release(resource) => {
      const before = resource.id;
      await delay(1);
      return resource.id == before ? resource.id : 0;
    }
    idle => {
      await delay(1);
      return 0;
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    const resource = BranchResource({ id: 42 });
    const route = Route.release(move resource);
    return await on thread.main publish(move route);
  });
  const result = await worker;
  return result == 42 ? 0 : 1;
}
