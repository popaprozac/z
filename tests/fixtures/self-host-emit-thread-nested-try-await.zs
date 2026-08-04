import { thread } from "std/thread";

struct WorkError {
  message: String;
}

function combine(left: i32, right: i32): i32 {
  return left + right;
}

function measure(in value: String): i32 {
  return i32(value.byteLength);
}

function consume(value: String): i32 {
  return i32(value.byteLength);
}

async function main(): i32 throws WorkError {
  const firstWorker = thread.spawn((): i32 throws WorkError => {
    return 20;
  });
  const secondWorker = thread.spawn((): i32 throws WorkError => {
    return 22;
  });
  const combined = combine(
    try await firstWorker,
    try await secondWorker
  );

  const measuredWorker = thread.spawn((): String throws WorkError => {
    return "measured";
  });
  const measured = measure(try await measuredWorker);

  const consumedWorker = thread.spawn((): String throws WorkError => {
    return "consumed";
  });
  const consumed = consume(try await consumedWorker);
  return combined + measured + consumed - 58;
}
