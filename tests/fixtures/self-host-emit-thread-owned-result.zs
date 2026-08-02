import { thread } from "std/thread";

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function main(): i32 {
  {
    const discardedSource = "discarded result";
    const discarded = thread.spawn(
      move (): String => duplicate(discardedSource)
    );
  }

  const source = "owned worker result";
  const worker = thread.spawn(move (): String => duplicate(source));
  const result = await worker;
  return i32(result.byteLength) - 19;
}
