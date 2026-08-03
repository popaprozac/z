import { thread } from "std/thread";

class MutableSnapshot {
  value: i32;

  function increment(inout this): void {
    this.value = this.value + 1;
  }
}

async function main(): i32 {
  const snapshot = new MutableSnapshot({ value: 41 });
  const worker = thread.spawn(move (): i32 => snapshot.value);
  return await worker;
}
