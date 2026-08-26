import console from "std/console";
import { TaskScope } from "std/async";
import { delay } from "std/time";
import { thread } from "std/thread";

struct PendingPublish {
  message: String;

  deinit {
    console.log(`released ${this.message}`);
  }
}

function duplicate(in value: String): String {
  return value.copyBytes(0, value.byteLength);
}

async function publish(pending: PendingPublish): i32 on thread.main {
  await delay(1000);
  console.log(`unexpected ${pending.message}`);
  return 42;
}

async function invoke(pending: PendingPublish): i32 {
  return await on thread.main publish(pending);
}

async function runPublish(): void {
  const pending = PendingPublish({
    message: duplicate("free publish"),
  });
  const result = await invoke(pending);
  if (result != 42) console.log("unexpected publish result");
}

async function main(): i32 on thread.main {
  const updates = new TaskScope();
  const control = updates.schedule(
    thread.main,
    async move (): void => await runPublish()
  );
  const requested = control.requestCancel();
  await updates.close();
  return control.accepted && requested ? 0 : 1;
}
