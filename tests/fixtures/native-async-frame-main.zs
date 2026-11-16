// Async main as a general native frame: direct timer awaits, owned locals
// across suspension, a suspending loop, and child results and errors.
import console from "std/console";
import { delay } from "std/time";

struct Job {
  id: i32;
  deinit {
    console.log(`released ${this.id}`);
  }
}

struct WorkError {
  code: i32;
}

async function work(job: Job): i32 {
  await delay(1);
  return job.id;
}

async function fail(code: i32): i32 throws WorkError {
  await delay(1);
  throw WorkError({ code });
}

async function main(): i32 {
  console.log("begin");
  await delay(1);
  const job = Job({ id: 4 });
  const value = await work(Job({ id: 5 }));
  let index: i32 = 0;
  while (index < 3) {
    await delay(1);
    index = index + 1;
  }
  const failed = attempt await fail(6);
  const code = match (failed) {
    success(result) => result;
    failure(error) => error.code;
  };
  console.log(`value ${value} job ${job.id} index ${index} code ${code}`);
  return value - 5 + code - 6;
}
