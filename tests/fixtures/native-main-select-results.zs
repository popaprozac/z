import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";

// A placed block with no declared result takes its final `select`'s type,
// in `main` and outside it, awaited or spawned.

struct Batch {
  names: Array<String>;
  title: String;
}

async function owned(count: i32): usize {
  let names = Array<String>();
  names.push(`first ${count}`);
  const kept = await on thread.main using (move names) {
    select names;
  };
  const batch = await on thread.main using (move kept) {
    select Batch({ names: kept, title: "batch" });
  };
  return batch.names.length + batch.title.byteLength;
}

async function optional(flag: boolean): i32 {
  const found = await on thread.main {
    const picked: Option<i32> = flag ? Option.some(4) : Option<i32>.none;
    select picked;
  };
  return match (found) {
    some(value) => value;
    none => -1;
  };
}

async function joined(base: i32): i32 {
  const first = task on thread.main {
    await delay(1);
    select base + 1;
  };
  const second = task on thread.main {
    select `text ${base}`;
  };
  const text = await second;
  const firstValue = await first;
  console.log(text);
  return firstValue;
}

async function operand(base: i32): i32 {
  const sum = 1 + await on thread.main {
    select base;
  };
  return sum;
}

async function main(): i32 {
  const owner = thread.spawn(async () => await owned(2));
  const ownedValue = await owner;
  console.log(`owned ${ownedValue}`);
  const present = thread.spawn(async () => await optional(true));
  const absent = thread.spawn(async () => await optional(false));
  const some = await present;
  const none = await absent;
  console.log(`optional ${some} ${none}`);
  const joiner = thread.spawn(async () => await joined(5));
  const joinedValue = await joiner;
  console.log(`joined ${joinedValue}`);
  const direct = await operand(6);
  const mainJoined = await joined(1);
  console.log(`main ${direct} ${mainJoined}`);
  const job = task on thread.main {
    select direct + 1;
  };
  const jobValue = await job;
  const total = 1 + await on thread.main {
    select 2;
  };
  console.log(`job ${jobValue} ${total}`);
  return 0;
}
