import { thread } from "std/thread";
import { sleep } from "std/time";

struct WriteError {
  message: String;
}

function persist(in source: String): void throws WriteError {
  if (source.byteLength == 0) {
    throw WriteError({ message: "empty input" });
  }
}

readonly class Writer on thread.main {
  constructor() {}

  async function write(
    in source: String
  ): void throws WriteError on thread.main {
    const snapshot = copy source;
    const worker = thread.spawn(move (): void throws WriteError => {
      sleep(10);
      try persist(in snapshot);
    });
    const written = attempt await worker;
    match (written) {
      success => return;
      failure(error) => throw error;
    }
  }
}

async function main(): i32 on thread.main {
  const writer = new Writer();
  const source = "native worker";
  const written = attempt await writer.write(in source);
  return match (written) {
    success => 0;
    failure(_) => 1;
  };
}
