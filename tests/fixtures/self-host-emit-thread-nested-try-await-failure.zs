import { thread } from "std/thread";

struct WorkError {
  message: String;
}

async function main(): i32 throws WorkError {
  const ignoredWorker = thread.spawn((): i32 throws WorkError => {
    return 42;
  });
  const failingWorker = thread.spawn((): i32 throws WorkError => {
    throw WorkError({ message: "selected failure" });
  });
  const selected = false
    ? try await ignoredWorker
    : try await failingWorker;
  return selected;
}
