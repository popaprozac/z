// Locals of an `async scope` live in the general native frame: children may
// borrow them, the scope joins its children before releasing them, and a
// scope inside a loop starts fresh each iteration.
import console from "std/console";
import { delay } from "std/time";

struct Report {
  value: i32;

  deinit {
    console.log(`released report ${this.value}`);
  }
}

async function inspectAfter(in report: Report, milliseconds: u64): i32 {
  await delay(milliseconds);
  console.log(`inspected ${report.value}`);
  return report.value;
}

async function total(values: Slice<i32>): i32 {
  await delay(1);
  return values[0] + values[1];
}

async function main(): i32 {
  let observed = 0;
  async scope {
    const first = Report({ value: 1 });
    const second = Report({ value: 2 });
    const firstTask = task inspectAfter(first, 3);
    task inspectAfter(second, 1);
    observed = await firstTask;
    console.log(`observed ${observed}`);
  }
  console.log("scope closed");
  let round: i32 = 0;
  while (round < 2) {
    async scope {
      const looped = Report({ value: 10 + round });
      task inspectAfter(looped, 1);
    }
    round = round + 1;
  }
  const pair = [20, 22];
  const sum = await total(pair);
  console.log(`sum ${sum}`);
  return observed - 1 + sum - 42;
}
