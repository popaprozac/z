import { scheduler, TaskControl, TaskScope } from "std/async";
import { Mutex } from "std/sync";
import { thread } from "std/thread";

struct CancellationState {
  ready: boolean;
}

function requestStoredCancellation(
  in state: Mutex<CancellationState>,
  in stored: Option<TaskControl>
): boolean {
  return match (in stored) {
    some(control) => state.withLock(
      (in value): boolean => value.ready && control.requestCancel()
    );
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
  const state = Mutex(CancellationState({ ready: true }));
  const requested = requestStoredCancellation(in state, in stored);
  await tasks.cancel();
  return requested ? 0 : 1;
}
