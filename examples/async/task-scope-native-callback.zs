import console from "std/console";
import { TaskScope } from "std/async";
import { thread } from "std/thread";
import native from "../interop/c/cross-thread-callback/native-callback.h";

function beginCalculation(taskScope: TaskScope): void {
  native.z_example_start_calculation(
    40,
    move (value: i32): i32 => {
      const accepted = taskScope.spawn(
        thread.main,
        move (): void => {
          console.log(`main-executor callback value=${value}`);
        }
      );
      return accepted ? value + 2 : -1;
    }
  );
}

function scheduleThenCancel(taskScope: TaskScope): void {
  taskScope.spawn(
    thread.main,
    move (): void => {
      console.error("cancelled TaskScope operation should not run");
    }
  );
}

async function main(): i32 {
  const manual = new TaskScope();
  scheduleThenCancel(manual);
  await manual.cancel();

  async scope updates {
    beginCalculation(updates);
    native.z_example_join_calculation();
  }
  return 0;
}
