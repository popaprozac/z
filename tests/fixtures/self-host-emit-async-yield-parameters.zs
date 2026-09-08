import console from "std/console";
import { scheduler } from "std/async";

class Receipt {
  label: String;
  deinit { console.log(`released ${this.label}`); }
}

struct Launch {
  selected: Receipt;
  discarded: Receipt;
  arguments: Array<String>;
}

function launch(): Launch {
  console.log("prepared launch");
  return Launch({
    selected: new Receipt({ label: "selected" }),
    discarded: new Receipt({ label: "discarded" }),
    arguments: Array<String>("notes", "draft"),
  });
}

async function deliver(request: Launch, state: i32, result: i32): i32 {
  const { selected, arguments } = move request;
  let task = 0;
  const frame = "frame-local";
  const executor = "same-executor";
  while (task < state) {
    await scheduler.yield();
    task = task + 1;
  }
  console.log(selected.label);
  if (arguments[1] != "draft" || frame != "frame-local" || executor != "same-executor") return 1;
  return task - result;
}

async function waitOwned(request: Launch): void {
  console.log("entered listener");
  const local = new Receipt({ label: "local" });
  while (true) {
    await scheduler.yield();
    console.log(request.selected.label);
    console.log(local.label);
  }
}

async function main(): i32 {
  return await deliver(launch(), 2, 2);
}
