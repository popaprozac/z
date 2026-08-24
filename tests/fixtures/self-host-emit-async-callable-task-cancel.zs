import console from "std/console";
import { scheduler } from "std/async";
import { thread } from "std/thread";

struct SuspendedOwner {
  marker: i32;

  deinit {
    console.log(`released ${this.marker}`);
  }
}

type AsyncInspect =
  async (in value: SuspendedOwner) => void on thread.any;

async function main(): i32 {
  async scope {
    const owner = SuspendedOwner({ marker: 42 });
    const inspect: AsyncInspect =
      async (in value: SuspendedOwner) => await scheduler.yield();
    const pending = task inspect(in owner);
    await pending.cancel();
    return owner.marker - 42;
  }
}
