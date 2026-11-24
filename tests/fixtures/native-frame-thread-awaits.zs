import console from "std/console";
import { thread } from "std/thread";
import { delay, sleep } from "std/time";

struct WorkError {
  code: i32;
}

function compute(value: i32): i32 {
  return value * 2;
}

function check(value: i32): i32 throws WorkError {
  if (value < 0) throw WorkError({ code: -value });
  return value;
}

// The ticks wait long enough that the workers below, joined first, never
// race them: thread start-up can exceed a millisecond on a loaded machine.
async function tick(label: String): void {
  await delay(50);
  console.log(`tick ${label}`);
}

// A general frame (it spawns a task) that also joins workers: their results,
// their typed errors, and a cancelled worker's join.
async function gather(): i32 throws WorkError {
  const ticker = task tick("gather");
  const doubled = thread.spawn((): i32 => compute(21));
  const failing = thread.spawn((): i32 throws WorkError => {
    return try check(-7);
  });
  const passing = thread.spawn((): i32 throws WorkError => {
    return try check(5);
  });
  const sleeper = thread.spawn((): i32 => {
    sleep(5);
    return 1;
  });
  const value = await doubled;
  console.log(`doubled ${value}`);
  const observed = attempt await failing;
  const code = match (observed) {
    success(found) => found;
    failure(error) => error.code;
  };
  console.log(`failure ${code}`);
  const passed = try await passing;
  await sleeper.cancel();
  await ticker;
  return value + code + passed;
}

async function main(): i32 {
  const progress = task tick("main");
  const result = attempt await gather();
  const total = match (result) {
    success(value) => value;
    failure(error) => -error.code;
  };
  await progress;
  console.log(`total ${total}`);
  return total - 54;
}
