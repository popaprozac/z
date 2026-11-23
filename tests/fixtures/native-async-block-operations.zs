import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// A scheduled operation may be a block: `async move (): void => { ... }` runs
// as a frame of its own that owns the closure's captures, so it may suspend
// more than once, keep locals, and join a worker. `await scope.close()` and
// `await scope.cancel()` suspend the function until the scope's operations
// have finished.

async function show(label: String, value: i32): void {
  await delay(1);
  console.log(`${label} shown ${value}`);
}

function submit(jobs: TaskScope, label: String, value: i32): boolean {
  const control: TaskControl = jobs.schedule(thread.main, async move (): void => {
    console.log(`${label} started`);
    await delay(1);
    const doubled = value * 2;
    await delay(1);
    console.log(`${label} finished ${doubled}`);
  });
  return control.accepted;
}

function submitWorker(jobs: TaskScope, value: i32): boolean {
  const control = jobs.schedule(thread.main, async move (): void => {
    const input = value;
    const worker = thread.spawn(async move (): i32 => {
      await delay(1);
      return input + 1;
    });
    const observed = await worker;
    console.log(`worker returned ${observed}`);
  });
  return control.accepted;
}

function submitLong(jobs: TaskScope): boolean {
  const control = jobs.schedule(thread.main, async move (): void => {
    console.log("long started");
    await delay(5000);
    console.log("long should not finish");
  });
  return control.accepted;
}

// An expression-bodied operation moves an owned capture on to the call it awaits.
function submitMoved(jobs: TaskScope, label: String, value: i32): boolean {
  const control = jobs.schedule(thread.main, async move (): void => await show(move label, value));
  return control.accepted;
}

// A callback's parameter is captured by the operation it schedules.
function relay(jobs: TaskScope, value: i32, deliver: (value: i32) => boolean): boolean {
  return deliver(value);
}

function submitRelayed(jobs: TaskScope, value: i32): boolean {
  return relay(jobs, value, move (received: i32): boolean => {
    const control = jobs.schedule(thread.main, async move (): void => {
      await delay(1);
      console.log(`relayed ${received}`);
    });
    return control.accepted;
  });
}

async function main(): i32 {
  const manual = new TaskScope();
  const queued = submitLong(manual);
  // Cancelled before it starts: nothing runs.
  await manual.cancel();
  console.log(`cancelled before start ${queued}`);

  const started = new TaskScope();
  const running = submitLong(started);
  await delay(1);
  // Cancelled while it sleeps.
  await started.cancel();
  console.log(`cancelled while running ${running}`);

  const closing = new TaskScope();
  const first = submit(closing, "first", 21);
  await closing.close();
  const late = submit(closing, "late", 0);
  console.log(`closed ${first} then ${late}`);

  // One operation per scope: each scope's exit waits for exactly one of them.
  async scope updates {
    const worked = submitWorker(updates, 41);
    console.log(`worker accepted ${worked}`);
  }
  async scope updates {
    const moved = submitMoved(updates, `moved label`, 3);
    console.log(`moved accepted ${moved}`);
  }
  async scope updates {
    const relayed = submitRelayed(updates, 9);
    console.log(`relayed accepted ${relayed}`);
  }
  return 0;
}
