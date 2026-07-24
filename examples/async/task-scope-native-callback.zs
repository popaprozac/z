import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";
import native from "../interop/c/cross-thread-callback/native-callback.h";

function beginCalculation(taskScope: TaskScope): void {
  native.z_example_start_calculation(
    40,
    move (value: i32): i32 => {
      const control: TaskControl = taskScope.schedule(
        thread.main,
        move (): void => {
          console.log(`main-executor callback value=${value}`);
        }
      );
      return control.accepted ? value + 2 : -1;
    }
  );
}

function beginAsyncCalculation(taskScope: TaskScope): void {
  native.z_example_start_calculation(
    41,
    move (value: i32): i32 => {
      const control = taskScope.schedule(
        thread.main,
        async move (): void => {
          const input = value;
          const worker = thread.spawn(async move (): i32 => {
            await delay(1);
            return input;
          });
          const observed = await worker;
          console.log(`joined async callback value=${observed}`);
        }
      );
      return control.accepted ? value + 1 : -1;
    }
  );
}

function scheduleThenCancel(taskScope: TaskScope): void {
  const synchronous = taskScope.schedule(
    thread.main,
    move (): void => {
      console.error("cancelled TaskScope operation should not run");
    }
  );
  const asynchronous = taskScope.schedule(
    thread.main,
    async move (): void => {
      await delay(1);
      console.error("cancelled async TaskScope operation should not run");
    }
  );
  if (!synchronous.accepted || !asynchronous.accepted) {
    console.error("TaskScope closed before cancellation example was queued");
  }
}

async function main(): i32 {
  const manual = new TaskScope();
  scheduleThenCancel(manual);
  await manual.cancel();

  async scope updates {
    beginCalculation(updates);
    native.z_example_join_calculation();
    beginAsyncCalculation(updates);
    native.z_example_join_calculation();
  }
  return 0;
}
