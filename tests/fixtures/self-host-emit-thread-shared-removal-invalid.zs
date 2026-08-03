import { thread } from "std/thread";

readonly class Snapshot {
  value: i32;
}

function consume(value: Snapshot): i32 {
  return value.value;
}

async function main(): i32 {
  const snapshot = new Snapshot({ value: 42 });
  const worker = thread.spawn(
    move (): i32 => consume(move snapshot)
  );
  return await worker;
}
