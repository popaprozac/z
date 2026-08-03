import { Mutex } from "std/sync";
import { thread } from "std/thread";
import { Snapshot } from "./snapshot.zs";
import { Counter, SharedCounter } from "./state.zs";

async function main(): i32 {
  const snapshot = new Snapshot({ value: 42 });
  const shared = new SharedCounter({
    state: Mutex(Counter({ value: 1 })),
  });
  const worker = thread.spawn(
    move (): i32 => snapshot.value + shared.read()
  );
  const value = await worker;
  return value - snapshot.value - shared.read();
}
