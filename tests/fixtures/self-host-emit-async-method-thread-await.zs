import { thread } from "std/thread";
import { sleep } from "std/time";

struct ReadError {
  message: String;
}

readonly class Reader on thread.main {
  constructor() {}

  async function measure(
    in source: String
  ): usize throws ReadError on thread.main {
    const snapshot = copy source;
    const worker = thread.spawn(move (): usize throws ReadError => {
      sleep(10);
      if (snapshot.byteLength == 0) {
        throw ReadError({ message: "empty input" });
      }
      return snapshot.byteLength;
    });
    const measured = attempt await worker;
    return match (measured) {
      success(value) => value;
      failure(error) => throw error;
    };
  }
}

async function main(): i32 on thread.main {
  const reader = new Reader();
  const source = "native worker";
  const measured = attempt await reader.measure(in source);
  return match (measured) {
    success(value) => i32(value) - 13;
    failure(_) => 1;
  };
}
