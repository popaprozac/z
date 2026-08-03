import { thread } from "std/thread";

readonly class ManagedSnapshot {
  value: i32;

  deinit {}
}

async function main(): i32 {
  const snapshot = new ManagedSnapshot({ value: 42 });
  const worker = thread.spawn(move (): i32 => snapshot.value);
  return await worker;
}
