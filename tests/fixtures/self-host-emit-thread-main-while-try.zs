import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct LoopTryError {
  message: String;
}

struct TryResource {
  id: i32;

  deinit {
    console.log(`released try iteration ${this.id}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

function labelFor(id: i32, shouldFail: boolean): String throws LoopTryError {
  if (shouldFail) {
    const message = id == 1 ? "before failed" : "after failed";
    throw LoopTryError({ message: duplicate(message) });
  }
  return duplicate("ready");
}

function validate(id: i32, shouldFail: boolean): void throws LoopTryError {
  if (shouldFail) {
    throw LoopTryError({ message: duplicate("before failed") });
  }
  if (id < 0) throw LoopTryError({ message: duplicate("invalid id") });
}

function finish(value: i32): i32 throws LoopTryError {
  return value;
}

async function inspect(
  limit: i32,
  failBeforeWait: boolean,
  failAfterWait: boolean
): i32 throws LoopTryError on thread.main {
  let current = 0;
  let observed = 0;
  while (current < limit) {
    current = current + 1;
    const resource = TryResource({ id: current });
    try validate(current, failBeforeWait && current == 1);
    const before = try labelFor(current, false);
    let replacement = duplicate("stale");
    replacement = try labelFor(current, false);
    await delay(1);
    const after = try labelFor(
      current,
      failAfterWait && current == 2
    );
    observed = observed
      + i32(before.byteLength)
      + i32(replacement.byteLength)
      + i32(after.byteLength);
    if (current == limit) return try finish(observed);
  }
  return observed;
}

async function main(): i32 on thread.main {
  const successWorker = thread.spawn(async (): i32 throws LoopTryError => {
    return try await on thread.main inspect(2, false, false);
  });
  const successResult = attempt await successWorker;
  const successCode: i32 = match (successResult) {
    success(value) => value;
    failure(error) => -i32(error.message.byteLength);
  };

  const beforeWorker = thread.spawn(async (): i32 throws LoopTryError => {
    return try await on thread.main inspect(2, true, false);
  });
  const beforeResult = attempt await beforeWorker;
  const beforeCode: i32 = match (beforeResult) {
    success(value) => -value;
    failure(error) => i32(error.message.byteLength);
  };

  const afterWorker = thread.spawn(async (): i32 throws LoopTryError => {
    return try await on thread.main inspect(2, false, true);
  });
  const afterResult = attempt await afterWorker;
  const afterCode: i32 = match (afterResult) {
    success(value) => -value;
    failure(error) => i32(error.message.byteLength);
  };

  return successCode == 30 && beforeCode == 13 && afterCode == 12 ? 0 : 1;
}
