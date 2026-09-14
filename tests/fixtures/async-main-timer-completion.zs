import console from "std/console";
import { TaskScope } from "std/async";
import { delay } from "std/time";
import { thread } from "std/thread";

struct Resource {
  id: i32;
  deinit { console.log(`released ${this.id}`); }
}
struct Failure {
  code: i32;
  deinit { console.log(`error ${this.code}`); }
}
function openResource(fail: boolean): Option<Resource> {
  if (fail) return Option<Resource>.none;
  return Option.some(Resource({ id: 2 }));
}
function verify(fail: boolean, code: i32): void throws Failure {
  if (fail) throw Failure({ code });
}
async function child(): void on thread.main { await delay(1); }

async function operation(stage: i32, guard: Resource): i32 throws Failure on thread.main {
  const selected = match (openResource(stage == 0)) {
    some(value) => move value;
    none => throw Failure({ code: 10 });
  };
  try verify(stage == 1, 11);
  await delay(1);
  const middle = Resource({ id: 3 });
  try verify(stage == 2, 12);
  const updates = new TaskScope();
  const control = updates.schedule(thread.main, async (): void => await child());
  await updates.close();
  await delay(1);
  try verify(stage == 3, 13);
  return selected.id + middle.id + guard.id + 36;
}

function report(outcome: Result<i32, Failure>): void {
  match (outcome) {
    success(value) => console.log(`result ${value}`);
    failure(error) => console.log(`failure ${error.code}`);
  }
}

async function hold(guard: Resource): void on thread.main {
  const selected = match (openResource(false)) { some(value) => move value; none => return; };
  console.log("entered");
  await delay(1000);
  console.log("unexpected completion");
}

async function cancelRunning(): void on thread.main {
  const updates = new TaskScope();
  const control = updates.schedule(thread.main, async (): void => await hold(Resource({ id: 4 })));
  await delay(5);
  control.requestCancel();
  await updates.close();
}

class Service on thread.main {
  deinit { console.log("service released"); }
  async function read(found: boolean): i32 {
    const selected = match (openResource(!found)) { some(value) => move value; none => return 7; };
    await delay(1);
    return selected.id;
  }
}

readonly class Capture {
  readonly id: i32;
  deinit { console.log(`capture ${this.id}`); }
}
function registerHandler(callback: () => i32): Resource throws Failure {
  try verify(callback() != 8, 99);
  return Resource({ id: 5 });
}
function readNumber(in value: i32): i32 { return value; }

async function main(): i32 on thread.main {
  const capture = new Capture({ id: 8 });
  if (readNumber(in capture.id) != 8) return 2;
  const registration = match (attempt registerHandler(move (): i32 => capture.id)) {
    success(value) => move value;
    failure(_) => return 1;
  };
  report(attempt await operation(0, Resource({ id: 1 })));
  const prefix = attempt await operation(1, Resource({ id: 1 }));
  report(move prefix);
  const middle = attempt await operation(2, Resource({ id: 1 }));
  report(move middle);
  const suffix = attempt await operation(3, Resource({ id: 1 }));
  report(move suffix);
  const success = attempt await operation(4, Resource({ id: 1 }));
  report(move success);
  await cancelRunning();
  const service = new Service({});
  const found = await service.read(true);
  const missing = await service.read(false);
  console.log(`${found}`);
  console.log(`${missing}`);
  return 0;
}
