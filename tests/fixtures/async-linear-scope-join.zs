import console from "std/console";
import { TaskScope as Scope, scheduler } from "std/async";
import { thread } from "std/thread";

struct Message { text: String; }
struct Failure { text: String; }
struct Guard {
  name: String;
  deinit { console.log(`released ${this.name}`); }
}

async function ready(): i32 {
  await scheduler.yield();
  return 0;
}

async function produce(fail: boolean, input: Message): Message throws Failure {
  const status = await ready();
  if (status != 0) throw Failure({ text: "bad readiness" });
  if (fail) throw Failure({ text: copy input.text });
  return input;
}

async function startup(
  early: boolean, fail: boolean, input: Message, updates: Scope
): Message throws Failure on thread.main {
  const before = Guard({ name: "parent" });
  if (early) return try await produce(fail, copy input);
  const later = Guard({ name: "continuation" });
  const result = attempt await produce(fail, copy input);
  console.log("before close");
  await updates.close();
  console.log("between joins");
  await updates.cancel();
  console.log("after cancel");
  return match (result) { success(value) => value; failure(error) => throw error; };
}

readonly class Reader {
  async function value(): i32 { return 42; }
  async function read(early: boolean, updates: Scope): i32 on thread.main {
    if (early) return await this.value();
    const answer = await this.value();
    await updates.cancel();
    return answer;
  }
}

function inspect(result: Result<Message, Failure>, fail: boolean): i32 {
  return match (result) {
    success(value) => !fail && value.text == "owned" ? 0 : 1;
    failure(error) => fail && error.text == "owned" ? 0 : 2;
  };
}

async function main(): i32 on thread.main {
  const updates = new Scope();
  const reader = new Reader({});
  const early = attempt await startup(true, false, Message({ text: "owned" }), updates);
  const late = attempt await startup(false, false, Message({ text: "owned" }), updates);
  const failed = attempt await startup(false, true, Message({ text: "owned" }), updates);
  const methodEarly = await reader.read(true, updates);
  const methodLate = await reader.read(false, updates);
  return inspect(move early, false) + inspect(move late, false)
    + inspect(move failed, true) + methodEarly + methodLate - 84;
}
