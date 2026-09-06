import { thread } from "std/thread";

struct FileError {
  message: String;
}

function loadText(in source: String): String throws String {
  if (source.byteLength == 0) throw "empty source";
  return copy source;
}

function storeText(in source: String): void throws String {
  if (source.byteLength == 0) throw "empty source";
}

readonly class Files on thread.main {
  async function readText(
    in source: String
  ): String throws FileError on thread.main {
    const snapshot = copy source;
    const worker = thread.spawn(move (): String throws String => {
      return try loadText(in snapshot);
    });
    const read = attempt await worker;
    return match (read) {
      success(value) => value;
      failure(message) => throw FileError({ message });
    };
  }

  async function writeText(
    in source: String
  ): void throws FileError on thread.main {
    const snapshot = copy source;
    const worker = thread.spawn(move (): void throws String => {
      try storeText(in snapshot);
    });
    const written = attempt await worker;
    match (written) {
      success => return;
      failure(message) => throw FileError({ message });
    }
  }
}

async function main(): i32 on thread.main {
  const files = new Files({});
  const source = "worker result context";
  const read = attempt await files.readText(in source);
  return match (read) {
    success(value) => value == "worker result context" ? 0 : 1;
    failure(_) => 2;
  };
}
