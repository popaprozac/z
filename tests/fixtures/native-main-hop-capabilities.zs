import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";

// Outside `main`, a placed block hops to the main executor with its declared
// capabilities: `inout` and `in` captures are the caller's own storage, which
// outlives the block (the caller awaits it, or joins the task), and a `move`
// capture is owned by the block.

struct Point {
  x: i32;
  y: i32;
}

struct Batch {
  names: Array<String>;
  title: String;
}

struct HopError {
  code: i32;
}

function batch(in title: String, count: i32): Batch {
  let names = Array<String>();
  let index = 0;
  while (index < count) {
    names.push(`${title}${index}`);
    index = index + 1;
  }
  return Batch({ names: move names, title: copy title });
}

async function mutate(start: i32): i32 {
  let count = start;
  let point = Point({ x: 1, y: 2 });
  await delay(1);
  await on thread.main using (inout count, inout point) {
    count = count + 41;
    point.x = point.x + 10;
  };
  const seen = await on thread.main using (in point): i32 {
    select point.x + point.y;
  };
  return count + seen;
}

async function owners(): usize {
  const borrowedTitle = "borrowed";
  let borrowed = batch(borrowedTitle, 2);
  const movedTitle = "moved";
  const moved = batch(movedTitle, 3);
  await on thread.main using (inout borrowed) {
    borrowed.names.push("added on main");
  };
  const read = await on thread.main using (in borrowed): usize {
    select borrowed.names.length + borrowed.title.byteLength;
  };
  const taken = await on thread.main using (move moved): usize {
    select moved.names.length + moved.title.byteLength;
  };
  return read + taken;
}

async function failing(): i32 throws HopError {
  let attempts = 0;
  const outcome = attempt await on thread.main using (inout attempts): i32 throws HopError {
    attempts = attempts + 1;
    if (attempts > 0) throw HopError({ code: 7 });
    select 0;
  };
  const code = match (outcome) {
    success(value) => value;
    failure(error) => error.code;
  };
  return code + attempts;
}

async function spawned(): i32 {
  let total = 1;
  async scope {
    const job = task on thread.main using (inout total) {
      total = total + 9;
    };
    await job;
  }
  return total;
}

async function main(): i32 {
  const direct = await mutate(1);
  const owned = await owners();
  const failed = attempt await failing();
  const failure = match (failed) {
    success(value) => value;
    failure(error) => -error.code;
  };
  const joined = await spawned();
  console.log(`main ${direct} ${owned} ${failure} ${joined}`);

  const worker = thread.spawn(async (): i32 => {
    const mutated = await mutate(2);
    const kept = await owners();
    const total = await spawned();
    return mutated + i32(kept) + total;
  });
  const fromWorker = await worker;
  console.log(`worker ${fromWorker}`);
  return 0;
}
