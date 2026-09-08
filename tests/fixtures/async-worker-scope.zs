import { TaskScope, scheduler } from "std/async";
import { thread } from "std/thread";
import probe from "./async-worker-scope.h";

// Native-only test instrumentation; no polling or lifetime logic lives here.
function initializeProbe(): void = raw c { initialize(); }
function listenerEntered(): void = raw c { listener_entered(); }
function listenerReleased(): void = raw c { listener_released(); }
function publishOnMain(): void = raw c { publish_on_main(); }
function resetEntry(): void = raw c { reset_entry(); }
function waitForEntry(): void = raw c { wait_for_entry(); }
function verifyProbe(): i32 = raw c { return verify(); }

struct ListenerResource {
  deinit { listenerReleased(); }
}

function publish(): void on thread.main { publishOnMain(); }

function queueWake(updates: TaskScope): boolean {
  const control = updates.schedule(thread.main, async (): void => publish());
  return control.accepted;
}

async function listen(updates: TaskScope, limit: i32): i32 {
  const resource = ListenerResource();
  const retained = updates;
  let turns = 0;
  while (turns < limit) {
    if (turns == 0) {
      if (!queueWake(retained)) return 0;
      listenerEntered();
    }
    await scheduler.yield();
    turns = turns + 1;
  }
  return turns;
}

async function main(): i32 on thread.main {
  initializeProbe();
  const updates = new TaskScope();
  const completed = thread.spawn(async move (): i32 => await listen(updates, 2));
  const count = await completed;
  if (count != 2) return 1;

  resetEntry();
  const cancelled = thread.spawn(async move (): i32 => {
    return await listen(updates, 2147483647);
  });
  waitForEntry();
  await cancelled.cancel();
  // The worker has released its resource. The parent still owns its scope;
  // accepted main work is joined explicitly, not dropped with the worker.
  await updates.close();
  return verifyProbe();
}
