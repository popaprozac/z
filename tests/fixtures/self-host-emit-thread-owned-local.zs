import { thread } from "std/thread";

struct WorkError {
  message: String;
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function main(): i32 {
  const directWorker = thread.spawn((): String => {
    const local: String = duplicate("direct");
    return local;
  });
  const direct = await directWorker;

  const successfulWorker = thread.spawn((): String throws WorkError => {
    const scratch: String = duplicate("clean me");
    const error: WorkError = WorkError({
      message: duplicate("worker failed"),
    });
    if (false) throw error;
    return scratch;
  });
  const successful = attempt await successfulWorker;
  const successLength: i32 = match (successful) {
    success(value) => i32(value.byteLength);
    failure(error) => i32(error.message.byteLength);
  };

  const failedWorker = thread.spawn((): String throws WorkError => {
    const scratch: String = duplicate("clean me");
    const error: WorkError = WorkError({
      message: duplicate("worker failed"),
    });
    if (true) throw error;
    return scratch;
  });
  const failed = attempt await failedWorker;
  const failureLength: i32 = match (failed) {
    success(value) => i32(value.byteLength);
    failure(error) => i32(error.message.byteLength);
  };

  return i32(direct.byteLength) - 6
    + successLength - 8
    + failureLength - 13;
}
