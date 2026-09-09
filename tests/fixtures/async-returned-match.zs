import console from "std/console";
import { scheduler } from "std/async";
import { thread } from "std/thread";

struct Message { text: String; deinit { console.log(`released ${this.text}`); } }
struct Failure { text: String; }
enum Readiness { primary Message, forwarded, failure Failure, }

async function ready(): i32 { await scheduler.yield(); return 0; }
async function serve(message: Message, fail: boolean): i32 throws Failure {
  const tick = await ready();
  if (fail) throw Failure({ text: "child error" });
  return 42;
}

async function startup(state: Option<Readiness>, fail: boolean): i32 throws Failure on thread.main {
  return match (state) {
    some(value) => match (value) {
      primary(message) => try await serve(move message, fail);
      forwarded => 0;
      failure(error) => throw error;
    }
    none => throw Failure({ text: "missing" });
  };
}

function status(result: Result<i32, Failure>): i32 {
  return match (result) { success(value) => value; failure(error) => -1; };
}

async function main(): i32 on thread.main {
  const first = attempt await startup(Option<Readiness>.some(Readiness.primary(Message({ text: "first" }))), false);
  const second = attempt await startup(Option<Readiness>.some(Readiness.primary(Message({ text: "second" }))), true);
  const forwarded = attempt await startup(Option<Readiness>.some(Readiness.forwarded), false);
  const failed = attempt await startup(Option<Readiness>.some(Readiness.failure(Failure({ text: "transport" }))), false);
  const missing = attempt await startup(Option<Readiness>.none, false);
  return status(move first) + status(move second) + status(move forwarded) + status(move failed) + status(move missing) - 39;
}
