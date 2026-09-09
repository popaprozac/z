import console from "std/console";
import { scheduler, TaskScope } from "std/async";
import { thread as threads } from "std/thread";

struct Message { text: String; }
struct Failure { text: String; }
struct Guard {
  name: String;
  deinit { console.log(`released ${this.name}`); }
}

function duplicate(in value: String): String { return value.copyBytes(0, value.byteLength); }

async function ready(): i32 { await scheduler.yield(); return 0; }
async function listen(): String {
  const status = await ready();
  if (status != 0) return "bad readiness";
  return duplicate("worker result");
}
async function produce(fail: boolean, input: Message): Message throws Failure {
  const status = await ready();
  if (status != 0 || fail) throw Failure({ text: copy input.text });
  return input;
}

async function startup(early: boolean, fail: boolean, input: Message): Message throws Failure {
  const before = Guard({ name: "parent" });
  const updates = new TaskScope();
  const worker = threads.spawn(async (): String => await listen());
  if (early) return try await produce(fail, copy input);
  const outcome = attempt await produce(fail, copy input);
  const after = Guard({ name: "continuation" });
  await worker.cancel();
  await updates.cancel();
  return match (outcome) { success(value) => value; failure(error) => throw error; };
}

function inspect(result: Result<Message, Failure>, fail: boolean): i32 {
  return match (result) {
    success(value) => !fail && value.text == "owned" ? 0 : 1;
    failure(error) => fail && error.text == "owned" ? 0 : 2;
  };
}
async function main(): i32 {
  const a = attempt await startup(true, false, Message({ text: duplicate("owned") }));
  const b = attempt await startup(false, false, Message({ text: duplicate("owned") }));
  const c = attempt await startup(true, true, Message({ text: duplicate("owned") }));
  const d = attempt await startup(false, true, Message({ text: duplicate("owned") }));
  return inspect(move a, false) + inspect(move b, false) + inspect(move c, true) + inspect(move d, true);
}
