import { scheduler, TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";

function requestStoredCancellation(
  in stored: Option<TaskControl>
): boolean {
  return match (in stored) {
    some(control) => control.requestCancel();
    none => false;
  };
}

async function main(): i32 {
  const tasks = new TaskScope();
  const control = tasks.schedule(
    thread.main,
    async (): void => await scheduler.yield()
  );
  const stored: Option<TaskControl> = Option.some(control);
  const requested = requestStoredCancellation(in stored);
  await tasks.cancel();
  return requested ? 0 : 1;
}
