import host from "./async-host-worker-wake.h";
import { TaskScope } from "std/async";
import { thread } from "std/thread";

function waitForHost(): i32 = raw c { return z_test_wait_for_host(); }
function deliver(value: i32): void on thread.main = raw c { z_test_deliver(value); }

async function read(): void on thread.main {
  const worker = thread.spawn((): i32 => waitForHost());
  const result = await worker;
  deliver(result);
}

async function main(): i32 on thread.main {
  const updates = new TaskScope();
  const control = updates.schedule(thread.main, async (): void => await read());
  await updates.close();
  return control.accepted ? 0 : 1;
}
