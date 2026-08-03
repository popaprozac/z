import { thread } from "std/thread";

struct WorkError {
  message: String;
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function main(): i32 {
  const directSource = duplicate("direct capture");
  const directWorker = thread.spawn(
    move (): String => move directSource
  );
  const direct = await directWorker;

  const blockSource = duplicate("block capture");
  const blockWorker = thread.spawn(move (): String => {
    const forwarded: String = move blockSource;
    return forwarded;
  });
  const block = await blockWorker;

  const fallbackSource = duplicate("fallback");
  const selectedSource = duplicate("selected");
  const selectedWorker = thread.spawn(move (): String => {
    if (fallbackSource.byteLength > 0) return move selectedSource;
    return move fallbackSource;
  });
  const selected = await selectedWorker;

  {
    const discardedSource = duplicate("discarded capture");
    const discarded = thread.spawn(
      move (): String => move discardedSource
    );
  }

  const errorSource = duplicate("capture failed");
  const failedWorker = thread.spawn(move (): i32 throws WorkError => {
    throw WorkError({ message: move errorSource });
  });
  const failed = attempt await failedWorker;
  const failureLength: i32 = match (failed) {
    success(value) => value;
    failure(error) => i32(error.message.byteLength);
  };

  return i32(direct.byteLength) - 14
    + i32(block.byteLength) - 13
    + i32(selected.byteLength) - 8
    + failureLength - 14;
}
