// Task spawns in general native frames: hot children run when the parent
// suspends, frames release their owners at join, scopes and function exit
// join leftover children, and a failure cancels the children it leaves.
import console from "std/console";
import { delay } from "std/time";
import { scheduler } from "std/async";

struct Job {
  id: i32;

  deinit {
    console.log(`released job ${this.id}`);
  }
}

struct TaskError {
  code: i32;
}

async function finish(job: Job, milliseconds: u64): i32 {
  await delay(milliseconds);
  console.log(`finished ${job.id}`);
  return job.id;
}

async function quick(job: Job): void {
  console.log(`quick ${job.id}`);
}

async function fail(code: i32): i32 throws TaskError {
  throw TaskError({ code });
}

async function slow(job: Job): void {
  await delay(60000);
  console.log(`unexpected ${job.id}`);
}

async function failing(): i32 throws TaskError {
  task slow(Job({ id: 9 }));
  const failure = task fail(3);
  return try await failure;
}

async function main(): i32 {
  const first = task finish(Job({ id: 1 }), 5);
  task quick(Job({ id: 2 }));
  console.log("spawned");
  await scheduler.yield();
  const value = await first;
  console.log(`value ${value}`);
  async scope {
    task finish(Job({ id: 3 }), 2);
    async scope {
      task quick(Job({ id: 4 }));
    }
    task finish(Job({ id: 5 }), 1);
  }
  console.log("scope done");
  const cancelled = task slow(Job({ id: 6 }));
  await delay(1);
  await cancelled.cancel();
  console.log("cancelled");
  const failed = attempt await failing();
  const code = match (failed) {
    success(result) => result;
    failure(error) => error.code;
  };
  console.log(`code ${code}`);
  return value - 1 + code - 3;
}
