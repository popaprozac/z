import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct RunError {
  code: i32;
}

struct RunLifetime {
  id: i32;

  deinit {
    console.log(`released run ${this.id}`);
  }
}

function requireRun(shouldFail: boolean): void throws RunError {
  if (shouldFail) throw RunError({ code: 42 });
}

async function finishRun(): i32 throws RunError on thread.main {
  await delay(1);
  return 7;
}

async function run(shouldFail: boolean): i32 throws RunError on thread.main {
  const lifetime = RunLifetime({ id: 1 });
  try requireRun(shouldFail);
  return try await finishRun();
}

async function main(): i32 on thread.main {
  const result = attempt await run(true);
  return match (result) {
    success(_) => 1;
    failure(error) => error.code == 42 ? 0 : 2;
  };
}
