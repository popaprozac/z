import { thread } from "std/thread";

struct OwnedError {
  message: String;
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function main(): i32 {
  const failedWorker = thread.spawn((): String throws OwnedError => {
    throw OwnedError({ message: "worker failed" });
  });
  const failed = attempt await failedWorker;
  const recovered: i32 = match (failed) {
    success(value) => i32(value.byteLength);
    failure(error) => i32(error.message.byteLength);
  };

  const successfulWorker = thread.spawn(
    (): String throws OwnedError => duplicate("owned success")
  );
  const succeeded = attempt await successfulWorker;
  const observed: i32 = match (succeeded) {
    success(value) => i32(value.byteLength);
    failure(error) => i32(error.message.byteLength);
  };
  return recovered - 13 + observed - 13;
}
