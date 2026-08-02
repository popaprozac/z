import { thread } from "std/thread";

struct WorkError {
  code: i32;
}

async function main(): i32 {
  const shouldFail = true;
  const worker = thread.spawn(move (): i32 throws WorkError => {
    if (shouldFail) {
      throw WorkError({ code: 7 });
    }
    return 42;
  });
  const failed = attempt await worker;
  const recovered: i32 = match (in failed) {
    success(value) => value;
    failure(error) => error.code;
  };

  const successfulWorker = thread.spawn((): i32 throws WorkError => 42);
  const value: i32 = match (attempt await successfulWorker) {
    success(value) => value;
    failure(error) => error.code;
  };
  return recovered - 7 + value - 42;
}
