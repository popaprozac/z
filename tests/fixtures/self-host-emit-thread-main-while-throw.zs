import console from "std/console";
import { delay } from "std/time";
import { thread } from "std/thread";

struct LoopError {
  message: String;
}

struct ThrowResource {
  id: i32;

  deinit {
    console.log(`released throw iteration ${this.id}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(limit: i32): i32 throws LoopError on thread.main {
  let current = 0;
  while (current < limit) {
    current = current + 1;
    const resource = ThrowResource({ id: current });
    await delay(1);
    if (current == 2) {
      throw LoopError({ message: duplicate("loop stopped") });
    }
  }
  return 0;
}

async function main(): i32 on thread.main {
  const worker = thread.spawn(async (): i32 throws LoopError => {
    return try await on thread.main publish(4);
  });
  const result = attempt await worker;
  return match (result) {
    success(value) => value + 1;
    failure(error) => i32(error.message.byteLength) - 12;
  };
}
