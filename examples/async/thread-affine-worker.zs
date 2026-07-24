import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct WorkError {
  code: i32;
}

async function buildStatus(value: i32, shouldFail: boolean): i32 throws WorkError {
  await delay(1);
  if (shouldFail) {
    throw WorkError({ code: value });
  }
  return value;
}

async function buildMainStatus(
  value: i32,
  shouldFail: boolean
): i32 throws WorkError on thread.main {
  await delay(1);
  if (shouldFail) {
    throw WorkError({ code: value });
  }
  return value;
}

async function main(): i32 throws WorkError {
  const shouldFail = false;
  const worker = thread.spawn(async move (): i32 throws WorkError => {
    const statusTask = task buildStatus(20, shouldFail);
    const status = try await statusTask;
    await delay(1);

    const mainValue = try await on thread.main: i32 throws WorkError {
      select try await buildMainStatus(22, shouldFail);
    };

    await delay(1);
    return status + mainValue;
  });

  const answer = try await worker;
  console.log(`thread-affine answer=${answer}`);
  return answer - 42;
}
