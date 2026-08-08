import { delay } from "std/time";
import { thread } from "std/thread";

struct PublishError {
  message: String;
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(
  value: String,
  shouldFail: boolean
): String throws PublishError on thread.main {
  if (shouldFail) {
    await delay(1);
    throw PublishError({ message: duplicate("publish failed") });
  }
  return value;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): String throws PublishError => {
    const payload = duplicate("owned request");
    return try await on thread.main publish(move payload, true);
  });
  const result = attempt await worker;
  return match (result) {
    success(value) => i32(value.byteLength);
    failure(error) => i32(error.message.byteLength) - 14;
  };
}
