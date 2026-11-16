// General native async frames: timer suspensions without scheduler.yield(),
// computed durations, suspension inside if/while, and non-scalar results.
import console from "std/console";
import { delay } from "std/time";

struct Job {
  id: i32;

  deinit {
    console.log(`released job ${this.id}`);
  }
}

struct Summary {
  label: String;
  ticks: i32;
}

struct DelayError {
  code: i32;
}

async function label(job: Job, milliseconds: u64): String {
  console.log(`start ${job.id}`);
  await delay(milliseconds + 1);
  return `job-${job.id}`;
}

async function count(job: Job, limit: i32): Summary {
  let ticks: i32 = 0;
  while (ticks < limit) {
    if (ticks % 2 == 0) {
      await delay(1);
    }
    ticks = ticks + 1;
  }
  return Summary({ label: `counted ${job.id}`, ticks });
}

async function failAfter(code: i32): i32 throws DelayError {
  await delay(1);
  if (code != 0) throw DelayError({ code });
  return 5;
}

async function relay(code: i32): i32 throws DelayError {
  const value = try await failAfter(code);
  await delay(1);
  return value + 1;
}

async function main(): i32 {
  const name = await label(Job({ id: 1 }), 1);
  console.log(name);
  const summary = await count(Job({ id: 2 }), 5);
  console.log(`${summary.label} ticks=${summary.ticks}`);
  const ok = attempt await relay(0);
  const okValue = match (ok) {
    success(value) => value;
    failure(error) => -error.code;
  };
  const failed = attempt await relay(9);
  const failedValue = match (failed) {
    success(value) => value;
    failure(error) => -error.code;
  };
  console.log(`relay ok=${okValue} failed=${failedValue}`);
  return okValue - 6 + failedValue + 9;
}
