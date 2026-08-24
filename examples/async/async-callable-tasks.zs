import console from "std/console";
import { scheduler } from "std/async";
import { thread } from "std/thread";

struct TaskOwner {
  marker: i32;

  deinit {
    console.log(`released ${this.marker}`);
  }
}

struct TaskError {
  code: i32;
}

type AsyncInspect =
  async (in value: TaskOwner) => void on thread.any;

type AsyncCompute =
  async (value: i32, shouldFail: boolean) => i32 throws TaskError on thread.any;

async function main(): i32 throws TaskError {
  async scope {
    const compute: AsyncCompute =
      async (value: i32, shouldFail: boolean): i32 throws TaskError => {
        await scheduler.yield();
        if (shouldFail) throw TaskError({ code: 7 });
        return value + 2;
      };
    const computedTask = task compute(40, false);
    const computed = try await computedTask;
    const failedTask = task compute(0, true);
    const failed = attempt await failedTask;
    const failureCode = match (failed) {
      success(value) => value;
      failure(error) => error.code;
    };

    const joinedOwner = TaskOwner({ marker: 41 });
    const inspect: AsyncInspect =
      async (in value: TaskOwner) => await scheduler.yield();
    const joined = task inspect(in joinedOwner);
    await joined;

    const cancelledOwner = TaskOwner({ marker: 42 });
    const cancelled = task inspect(in cancelledOwner);
    await cancelled.cancel();

    const scopedOwner = TaskOwner({ marker: 43 });
    task inspect(in scopedOwner);

    return computed + failureCode
      + joinedOwner.marker + cancelledOwner.marker + scopedOwner.marker
      - 175;
  }
}
