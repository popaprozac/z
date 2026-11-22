import console from "std/console";
import { delay } from "std/time";

// Owned locals declared inside suspending blocks live in the general frame:
// each is released exactly once, at its block's end, on `break`/`continue`,
// on `return`/`throw` from inside the block, or when the frame is cancelled
// while suspended inside the block.

struct Resource {
  label: String;

  deinit {
    console.log(`released ${this.label}`);
  }
}

struct Failure {
  code: i32;
}

enum Choice {
  keep Resource,
  skip,
}

function named(in prefix: String, value: i32): String {
  return `${prefix} ${value}`;
}

async function branch(flag: boolean): i32 {
  let total = 0;
  if (flag) {
    const inside = Resource({ label: "branch" });
    await delay(1);
    total = total + i32(inside.label.byteLength);
  }
  console.log("after branch");
  return total;
}

async function loop(limit: i32): i32 {
  let index = 0;
  let sum = 0;
  while (index < limit) {
    index = index + 1;
    const prefix = "step";
    const step = Resource({ label: named(prefix, index) });
    if (index == 2) continue;
    await delay(1);
    sum = sum + index;
    if (index == 3) break;
  }
  return sum;
}

async function early(mode: i32): i32 throws Failure {
  if (mode > 0) {
    const prefix = "held";
    const held = Resource({ label: named(prefix, mode) });
    await delay(1);
    if (mode == 1) return 1;
    throw Failure({ code: mode });
  }
  return 0;
}

async function arm(choice: Choice): i32 {
  match (choice) {
    keep(kept) => {
      const extra = Resource({ label: "arm extra" });
      await delay(1);
      console.log(`kept ${kept.label} with ${extra.label}`);
      return 1;
    }
    skip => {
      return 0;
    }
  }
}

async function sleeper(): void {
  if (true) {
    const pending = Resource({ label: "pending" });
    await delay(1000);
    console.log("unexpected wake");
  }
}

async function main(): i32 {
  const branched = await branch(true);
  console.log(`branch ${branched}`);

  const looped = await loop(5);
  console.log(`loop ${looped}`);

  const returned = attempt await early(1);
  const returnedValue = match (returned) {
    success(value) => value;
    failure(error) => error.code;
  };
  console.log(`early return ${returnedValue}`);
  const thrown = attempt await early(2);
  const thrownValue = match (thrown) {
    success(value) => value;
    failure(error) => error.code;
  };
  console.log(`early throw ${thrownValue}`);

  const chosen = await arm(Choice.keep(Resource({ label: "payload" })));
  console.log(`arm ${chosen}`);

  const job = task sleeper();
  await delay(5);
  await job.cancel();
  console.log("cancelled sleeper");
  return 0;
}
