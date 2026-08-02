import { thread } from "std/thread";

readonly class Snapshot {
  value: i32;
}

async function main(): i32 {
  const snapshot = new Snapshot({ value: 42 });
  const worker = thread.spawn(move (): i32 => snapshot.value);
  const value = await worker;
  return value - 42;
}
