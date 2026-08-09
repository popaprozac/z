import console from "std/console";
import { delay, sleep } from "std/time";
import { thread } from "std/thread";

struct LoopResource {
  id: i32;

  deinit {
    console.log(`released loop frame ${this.id}`);
  }
}

async function publish(): i32 on thread.main {
  let iteration = 0;
  while (iteration < 2) {
    iteration = iteration + 1;
    const resource = LoopResource({ id: iteration });
    console.log("entered loop main segment");
    await delay(1000);
    console.log("unexpected loop continuation resume");
  }
  return iteration;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 => {
    return await on thread.main publish();
  });
  sleep(10);
  await worker.cancel();
  return 0;
}
