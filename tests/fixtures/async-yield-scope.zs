import { TaskScope, TaskControl, scheduler } from "std/async";
import { thread } from "std/thread";
import pthread from "pthread.h";
import io from "stdio.h";

function publish(): void on thread.main = raw c {
#if defined(__APPLE__)
  if (pthread_main_np() == 0) abort();
#endif
  puts("wake on main");
}

function queueWake(updates: TaskScope): boolean {
  const control = updates.schedule(thread.main, async (): void => publish());
  return control.accepted;
}

async function listen(updates: TaskScope, limit: i32): i32 {
  const retained = updates;
  let turns = 0;
  while (turns < limit) {
    if (!queueWake(retained)) return turns;
    await scheduler.yield();
    turns = turns + 1;
  }
  return turns;
}

async function holdControl(control: TaskControl): void {
  const retained = control;
  await scheduler.yield();
  if (!retained.accepted) return;
  await scheduler.yield();
}

async function main(): i32 on thread.main {
  const updates = new TaskScope();
  const sent = await listen(updates, 2);
  await updates.close();
  return sent - 2;
}
