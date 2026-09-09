import console from "std/console";
import { TaskScope as Scope, scheduler } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

struct Message { text: String; }
struct Failure { text: String; }
export c function nativeEcho(value: i32): i32 { return value; }
struct Guard {
  name: String;
  deinit { console.log(`released ${this.name}`); }
}

async function work(): void on thread.main { await delay(1); }
function queue(updates: Scope): boolean {
  const control = updates.schedule(thread.main, async (): void => await work());
  return control.accepted;
}
async function ready(): i32 { await scheduler.yield(); return 0; }
async function produce(fail: boolean, input: Message): Message throws Failure {
  const status = await ready();
  if (status != 0 || fail) throw Failure({ text: copy input.text });
  return input;
}

async function startup(early: boolean, fail: boolean, input: Message): Message throws Failure on thread.main {
  const before = Guard({ name: "parent" });
  const first = new Scope();
  const firstHandle = move first;
  if (!queue(firstHandle)) throw Failure({ text: "rejected" });
  if (early) return try await produce(fail, copy input);
  const result = attempt await produce(fail, copy input);
  const second = new Scope();
  if (!queue(second)) throw Failure({ text: "rejected" });
  return match (result) { success(value) => value; failure(error) => throw error; };
}

readonly class Reader {
  async function read(early: boolean, fail: boolean): Message throws Failure on thread.main {
    const updates = new Scope();
    if (!queue(updates)) throw Failure({ text: "rejected" });
    if (early) return try await produce(fail, Message({ text: "owned" }));
    const result = attempt await produce(fail, Message({ text: "owned" }));
    await updates.cancel();
    return match (result) { success(value) => value; failure(error) => throw error; };
  }
}

function inspect(result: Result<Message, Failure>, fail: boolean): i32 {
  return match (result) {
    success(value) => !fail && value.text == "owned" ? 0 : 1;
    failure(error) => fail && error.text == "owned" ? 0 : 2;
  };
}
async function main(): i32 on thread.main {
  const a = attempt await startup(true, false, Message({ text: "owned" }));
  const b = attempt await startup(false, false, Message({ text: "owned" }));
  const c = attempt await startup(true, true, Message({ text: "owned" }));
  const d = attempt await startup(false, true, Message({ text: "owned" }));
  const reader = new Reader({});
  const e = attempt await reader.read(true, false);
  const f = attempt await reader.read(false, false);
  const g = attempt await reader.read(true, true);
  const h = attempt await reader.read(false, true);
  return inspect(move a, false) + inspect(move b, false) + inspect(move c, true) + inspect(move d, true)
    + inspect(move e, false) + inspect(move f, false) + inspect(move g, true) + inspect(move h, true);
}
