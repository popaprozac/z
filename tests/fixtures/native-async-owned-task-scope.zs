import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// An async function owns each `new TaskScope()` it creates: returning closes
// the scope and joins its operations, and a failure cancels them. Nothing the
// scope accepted outlives the function.

enum Failure { broken }

async function announce(value: i32, wait: u64): void {
  console.log(`operation ${value} started`);
  await delay(wait);
  console.log(`operation ${value} finished`);
}

function submit(jobs: TaskScope, value: i32, wait: u64): boolean {
  const control: TaskControl = jobs.schedule(thread.main, async move (): void => await announce(value, wait));
  return control.accepted;
}

async function owner(): i32 {
  await delay(1);
  const jobs = new TaskScope();
  const accepted = submit(jobs, 1, 2);
  console.log(`owner submitted ${accepted}`);
  return 4;
}

// An earlier `close` is the scope's boundary; the function's end finds it joined.
async function closes(): i32 {
  await delay(1);
  const jobs = new TaskScope();
  const accepted = submit(jobs, 2, 2);
  await jobs.close();
  const late = submit(jobs, 3, 2);
  console.log(`closes submitted ${accepted} then ${late}`);
  return 5;
}

async function failing(): i32 throws Failure {
  await delay(1);
  const jobs = new TaskScope();
  const accepted = submit(jobs, 4, 5000);
  // The operation starts, then the throw cancels it.
  await delay(1);
  if (accepted) throw Failure.broken;
  return 6;
}

async function main(): i32 {
  const owned = await owner();
  console.log(`owner returned ${owned}`);
  const closed = await closes();
  console.log(`closes returned ${closed}`);
  const failed = attempt await failing();
  match (failed) {
    success(value) => console.log(`failing returned ${value}`);
    failure(_) => console.log("failing failed");
  }
  return 0;
}
