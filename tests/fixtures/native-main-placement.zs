import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";

struct Counter {
  value: i32;
}

function readStatus(value: i32): i32 {
  console.log(`read ${value}`);
  return value;
}

async function loadStatus(value: i32): i32 {
  console.log(`load ${value}`);
  await delay(1);
  console.log(`loaded ${value}`);
  return value;
}

class Service {
  async function fetch(value: i32): i32 {
    await delay(1);
    return value + 1;
  }
}

function show(in text: String, count: i32): void {
  console.log(`${text} ${count}`);
}

// `main` runs on the main executor, so `on thread.main` placements run where
// they are, interleaved with main's own tasks as in Stage 0.
async function main(): i32 {
  const hopped = await on thread.main readStatus(20);
  const placedTask = task on thread.main loadStatus(21);
  console.log("spawned");
  const awaited = await on thread.main loadStatus(30);
  const placed = await placedTask;
  const service = new Service({});
  const fetched = await on thread.main service.fetch(40);

  let counter = Counter({ value: 1 });
  let values = Array<i32>();
  values.push(5);
  const captured = await on thread.main using (inout counter, move values): i32 {
    counter.value = counter.value + values[0];
    select counter.value * 2;
  };

  const status = "placed status";
  const count = 3;
  await on thread.main using (in status, in count) {
    show(status, count);
  }

  console.log(`total ${hopped + placed + awaited + fetched} captured ${captured} counter ${counter.value}`);
  return 0;
}
