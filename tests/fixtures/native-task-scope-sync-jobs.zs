import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// `TaskScope.schedule` takes a synchronous operation as well as an async
// one: a job on the scope's executor that owns its captures, runs once
// unless it is cancelled first, and is refused once the scope has closed.

async function announce(value: i32): void {
  console.log(`async job ${value}`);
  await delay(1);
}

function submit(jobs: TaskScope, value: i32): boolean {
  const control: TaskControl = jobs.schedule(thread.main, move (): void => {
    console.log(`sync job ${value}`);
  });
  return control.accepted;
}

function submitMixed(jobs: TaskScope, value: i32): boolean {
  const plain = jobs.schedule(thread.main, (): void => {
    console.log("sync job without captures");
  });
  const suspended = jobs.schedule(thread.main, async move (): void => await announce(value));
  return plain.accepted && suspended.accepted;
}

function submitThenRequestCancel(jobs: TaskScope): boolean {
  const control = jobs.schedule(thread.main, move (): void => {
    console.error("a cancelled operation should not run");
  });
  return control.requestCancel();
}

async function main(): i32 {
  // `main` suspends in a loop, so it runs as a frame on the main executor
  // and the scope's jobs queue behind it.
  let rounds = 0;
  while (rounds < 2) {
    await delay(1);
    rounds = rounds + 1;
  }
  const jobs = new TaskScope();
  const first = submit(jobs, 40);
  const mixed = submitMixed(jobs, 41);
  const requested = submitThenRequestCancel(jobs);
  console.log(`accepted ${first} ${mixed} ${requested}`);
  await jobs.close();
  const late = submit(jobs, 43);
  console.log(`closed, late ${late}`);
  // A worker thread submits too; its job runs on main before that scope
  // closes. The scope holds nothing else, so no other job races the worker.
  const threaded = new TaskScope();
  const worker = thread.spawn(move (): boolean => submit(threaded, 42));
  const fromWorker = await worker;
  await threaded.close();
  console.log(`worker submitted ${fromWorker}`);
  return 0;
}
