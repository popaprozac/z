import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// An error that propagates out of a named `async scope` through `try` leaves
// it as a `throw` does: the scope's operations are cancelled and joined before
// the function fails. A `return` evaluates its value, then the scope joins
// the children the value did not already join.

enum Failure { broken }

async function announce(value: i32, wait: u64): void {
  console.log(`operation ${value} started`);
  await delay(wait);
  console.log(`operation ${value} finished`);
}

function submit(updates: TaskScope, value: i32, wait: u64): boolean {
  const control: TaskControl = updates.schedule(thread.main, async move (): void => await announce(value, wait));
  return control.accepted;
}

async function fails(): i32 throws Failure {
  await delay(1);
  throw Failure.broken;
}

async function propagates(): i32 throws Failure {
  async scope updates {
    const accepted = submit(updates, 1, 5000);
    const value = try await fails();
    console.log(`propagates body should not continue ${accepted} ${value}`);
  }
  return 9;
}

async function child(value: i32): i32 {
  console.log(`child ${value} started`);
  await delay(1);
  console.log(`child ${value} finished`);
  return value;
}

async function joinsOwn(): i32 {
  async scope {
    const pending = task child(3);
    task child(4);
    return await pending;
  }
}

async function main(): i32 {
  const propagated = attempt await propagates();
  match (propagated) {
    success(value) => console.log(`propagates returned ${value}`);
    failure(_) => console.log("propagates failed");
  }
  const joined = await joinsOwn();
  console.log(`joinsOwn ${joined}`);
  return 0;
}
