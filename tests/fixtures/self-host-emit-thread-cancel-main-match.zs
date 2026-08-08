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
  publish,
  idle,
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(route: Route): i32 on thread.main {
  match (route) {
    publish => {
      const staged = MatchFrameResource({
        message: duplicate("match main frame"),
      });
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
    return await on thread.main publish(Route.publish);
  });
  sleep(10);
  await worker.cancel();
  return 0;
}
