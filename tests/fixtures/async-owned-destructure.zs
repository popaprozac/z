import console from "std/console";
import { scheduler } from "std/async";
import { delay } from "std/time";
import { thread } from "std/thread";

class Receipt {
  label: String;
  deinit { console.log(`released ${this.label}`); }
}

struct Delivery {
  selected: Receipt;
  discarded: Receipt;
  title: String;
  tags: Array<String>;
  result: Option<String>;
}

struct Failure { code: i32; }
struct Coordinates { x: i32; y: i32; }

struct Snapshot {
  title: String;
  tags: Array<String>;
  result: Option<String>;
}

function prepare(in label: String): Delivery {
  console.log(`prepared ${label}`);
  return Delivery({
    selected: new Receipt({ label: `${label} selected` }),
    discarded: new Receipt({ label: `${label} discarded` }),
    title: copy label,
    tags: Array<String>("notes", "draft"),
    result: Option.some("ready"),
  });
}

function fail(): Delivery throws Failure { throw Failure({ code: 7 }); }

async function inspect(): i32 {
  const original = Snapshot({ title: "copied", tags: Array<String>("notes", "draft"), result: Option.some("ready") });
  const { title: snapshot, tags: copiedTags, result: copiedResult } = copy original;
  const { title, tags, result } = move original;
  const { selected } = prepare("inspected");
  await scheduler.yield();
  if (snapshot != title || copiedTags[1] != tags[1]) return 1;
  if (selected.label != "inspected selected") return 2;
  const invalidCopy = match (in copiedResult) { some(value) => value != "ready"; none => true; };
  if (invalidCopy) return 3;
  const invalidMove = match (in result) { some(value) => value != "ready"; none => true; };
  if (invalidMove) return 4;
  console.log("inspected");
  return 0;
}

async function scoped(): void {
  let index = 0;
  while (index < 2) {
    async scope {
      const { selected, title } = prepare("scoped");
      await scheduler.yield();
      console.log(selected.label);
      if (title != "scoped") return;
    }
    console.log("scope ended");
    index = index + 1;
  }
}

async function returnOwner(): Receipt {
  const { selected } = prepare("returned");
  await scheduler.yield();
  return selected;
}

async function prepareAsync(): Delivery {
  await scheduler.yield();
  return prepare("awaited");
}

async function inspectAwaited(): void {
  const { selected } = await prepareAsync();
  await scheduler.yield();
  console.log(selected.label);
}

async function inspectTitle(in title: String): void {
  await scheduler.yield();
  console.log(`borrowed ${title}`);
}

async function joinBorrow(): void {
  async scope {
    const { title } = prepare("borrowed");
    task inspectTitle(in title);
  }
  console.log("borrow joined");
}

async function failBefore(): void throws Failure {
  const { selected } = try fail();
  await scheduler.yield();
  console.log(selected.label);
}

async function failAfter(): void throws Failure {
  const { selected } = prepare("failed");
  await scheduler.yield();
  console.log(selected.label);
  throw Failure({ code: 9 });
}

async function waitOwned(): void {
  const { selected } = prepare("cancelled");
  await delay(60000);
  console.log(selected.label);
}

async function preparePending(): Delivery {
  const delivery = prepare("initializing");
  await delay(60000);
  return delivery;
}

async function waitInitializing(): void {
  const { selected } = await preparePending();
  console.log(selected.label);
}

async function main(): i32 {
  const worker = thread.spawn(async (): i32 => {
    const { title, tags } = Snapshot({
      title: "worker", tags: Array<String>("notes"), result: Option.none,
    });
    await scheduler.yield();
    return title == "worker" && tags[0] == "notes" ? 0 : 1;
  });
  const workerStatus = await worker;
  if (workerStatus != 0) return 11;
  let { x: position } = Coordinates({ x: 20, y: 22 });
  await scheduler.yield();
  position = position + 22;
  if (position != 42) return 10;
  const inspected = await inspect();
  if (inspected != 0) return inspected;
  await scoped();
  await inspectAwaited();
  await joinBorrow();
  const returned = await returnOwner();
  console.log(returned.label);
  const before = attempt await failBefore();
  const invalidBefore = match (before) { success => true; failure(error) => error.code != 7; };
  if (invalidBefore) return 5;
  const after = attempt await failAfter();
  const invalidAfter = match (after) { success => true; failure(error) => error.code != 9; };
  if (invalidAfter) return 6;
  const waiting = task waitOwned();
  await scheduler.yield();
  await waiting.cancel();
  console.log("joined cancellation");
  const initializing = task waitInitializing();
  await scheduler.yield();
  await scheduler.yield();
  await initializing.cancel();
  console.log("joined initializer cancellation");
  return 0;
}
