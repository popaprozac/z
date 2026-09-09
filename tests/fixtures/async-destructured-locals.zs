import { scheduler } from "std/async";

struct Resource {
  name: String;
}
struct Pair { first: Resource; second: Resource; unselected: Resource; }
struct Failure { code: i32; }

async function ready(): i32 { await scheduler.yield(); return 42; }
async function produce(fail: boolean): i32 throws Failure {
  const value = await ready();
  if (fail) throw Failure({ code: value });
  return value;
}
function consume(value: Resource): void {}
function inspect(in value: Resource): i32 { return value.name.byteLength == 0 ? 1 : 0; }

async function startup(early: boolean, fail: boolean): i32 throws Failure {
  const { first: used, second: retained } = Pair({
    first: Resource({ name: "used" }), second: Resource({ name: "retained" }),
    unselected: Resource({ name: "unselected" }),
  });
  consume(move used);
  if (early) return try await produce(fail);
  const outcome = attempt await produce(fail);
  const { first: later, second: last } = Pair({
    first: Resource({ name: "later" }), second: Resource({ name: "last" }),
    unselected: Resource({ name: "unselected" }),
  });
  inspect(in retained);
  inspect(in later);
  inspect(in last);
  return match (outcome) { success(value) => value; failure(error) => throw error; };
}

function status(result: Result<i32, Failure>): i32 {
  return match (result) { success(value) => value; failure(error) => error.code; };
}
async function main(): i32 {
  const a = attempt await startup(true, false);
  const b = attempt await startup(false, false);
  const c = attempt await startup(true, true);
  const d = attempt await startup(false, true);
  return status(a) + status(b) + status(c) + status(d) - 168;
}
