import console from "std/console";
import { delay, sleep } from "std/time";
import { thread } from "std/thread";

struct PublishError {
  message: String;
}

struct FrameResource {
  message: String;

  deinit {
    console.log(`released ${this.message}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(
  value: String,
  shouldFail: boolean
): String throws PublishError on thread.main {
  const staged = FrameResource({ message: duplicate("main frame") });
  console.log("entered main segment");
  await delay(1000);
  console.log("unexpected suspended continuation resume");
  if (shouldFail) {
    throw PublishError({ message: duplicate("cancelled publish") });
  }
  return value;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(
    async (): String throws PublishError => {
      const payload = duplicate("pending main request");
      return try await on thread.main publish(move payload, true);
    }
  );
  sleep(10);
  await worker.cancel();
  return 0;
}
