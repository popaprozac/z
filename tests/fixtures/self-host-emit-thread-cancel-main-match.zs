import console from "std/console";
import { delay, sleep } from "std/time";
import { thread } from "std/thread";

struct MatchFrameResource {
  message: String;

  deinit {
    console.log(`released ${this.message}`);
  }
}

enum Route {
  publish MatchFrameResource,
  idle,
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

function identity(route: Route): Route {
  return route;
}

async function publish(route: Route): i32 on thread.main {
  match (identity(route)) {
    publish(staged) => {
      console.log("entered match main segment");
      await delay(1000);
      console.log("unexpected match continuation resume");
      return staged.message.byteLength == 0 ? 1 : 42;
    }
    idle => {
      return 0;
    }
  }
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    const resource = MatchFrameResource({
      message: duplicate("match payload frame"),
    });
    const route = Route.publish(move resource);
    return await on thread.main publish(move route);
  });
  sleep(10);
  await worker.cancel();
  return 0;
}
