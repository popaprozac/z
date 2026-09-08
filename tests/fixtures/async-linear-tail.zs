import console from "std/console";
import { scheduler } from "std/async";
import { thread } from "std/thread";

struct Message { text: String; }
struct Failure { text: String; }
struct Guard {
  name: String;
  deinit { console.log(`released ${this.name}`); }
}

readonly class Producer {
  async function produce(fail: boolean, in input: Message): Message throws Failure {
    if (fail) throw Failure({ text: copy input.text });
    return Message({ text: copy input.text });
  }

  async function startup(early: boolean, fail: boolean, input: Message): Message throws Failure {
    const startupSentinel = Guard({ name: "before" });
    if (early) return try await this.produce(fail, in input);
    const later = Guard({ name: "later" });
    const result = attempt await this.produce(fail, in input);
    return match (result) { success(value) => value; failure(error) => throw error; };
  }
}

async function ready(): i32 {
  await scheduler.yield();
  return 0;
}

async function produce(fail: boolean, input: Message): Message throws Failure {
  const readyStatus = await ready();
  if (readyStatus != 0) throw Failure({ text: "unexpected readiness" });
  if (fail) throw Failure({ text: copy input.text });
  return input;
}

async function startup(
  early: boolean, fail: boolean, input: Message
): Message throws Failure on thread.main {
  const startupSentinel = Guard({ name: "before" });
  if (early) return try await produce(fail, copy input);
  const later = Guard({ name: "later" });
  const result = attempt await produce(fail, copy input);
  return match (result) {
    success(value) => value;
    failure(error) => throw error;
  };
}

function inspect(result: Result<Message, Failure>, fail: boolean): i32 {
  return match (result) {
    success(value) => !fail && value.text == "owned" ? 0 : 1;
    failure(error) => fail && error.text == "owned" ? 0 : 2;
  };
}

async function main(): i32 on thread.main {
  const producer = new Producer({});
  const early = attempt await startup(true, false, Message({ text: "owned" }));
  const late = attempt await startup(false, false, Message({ text: "owned" }));
  const earlyFailure = attempt await startup(true, true, Message({ text: "owned" }));
  const lateFailure = attempt await startup(false, true, Message({ text: "owned" }));
  const methodEarly = attempt await producer.startup(true, false, Message({ text: "owned" }));
  const methodLate = attempt await producer.startup(false, false, Message({ text: "owned" }));
  const methodEarlyFailure = attempt await producer.startup(true, true, Message({ text: "owned" }));
  const methodLateFailure = attempt await producer.startup(false, true, Message({ text: "owned" }));
  return inspect(move early, false) + inspect(move late, false)
    + inspect(move earlyFailure, true) + inspect(move lateFailure, true)
    + inspect(move methodEarly, false) + inspect(move methodLate, false)
    + inspect(move methodEarlyFailure, true) + inspect(move methodLateFailure, true);
}
