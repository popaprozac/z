import console from "std/console";
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

struct Lease {
  id: i32;

  deinit {
    console.log(`released lease ${this.id}`);
  }
}

// An owner in the stream's frame: released when the stream finishes or is
// dropped unfinished.
async function leased(id: i32, count: i32): AsyncGenerator<i32> {
  const lease = Lease({ id });
  let index = 0;
  while (index < count) {
    await delay(1);
    yield lease.id * 10 + index;
    index = index + 1;
  }
}

// A stream that steps another stream and reports a completion value.
async function doubled(count: i32): AsyncGenerator<i32, i32> {
  let source = leased(2, count);
  let total = 0;
  let running = true;
  let value = 0;
  while (running) {
    value = -1;
    match (await source.next()) {
      some(found) => value = found;
      none => {}
    }
    if (value < 0) {
      running = false;
    } else {
      total = total + value;
      yield value * 2;
    }
  }
  return total;
}

// Dropping an unfinished stream releases its owners.
async function partialDrop(): void {
  let partial = leased(1, 3);
  const first = await partial.next();
  const firstValue = match (first) {
    some(value) => value;
    none => -1;
  };
  console.log(`partial ${firstValue}`);
}

async function firstOver(limit: i32): i32 {
  for await (const value of leased(3, 5)) {
    if (value > limit) return value;
  }
  return -1;
}

async function main(): i32 {
  await partialDrop();
  let sum = 0;
  for await (const value of leased(4, 4)) {
    sum = sum + value;
    if (value == 41) break;
  }
  console.log(`sum ${sum}`);
  let stream = doubled(2);
  let finished = false;
  while (!finished) {
    match (await stream.next()) {
      yielded(value) => console.log(`doubled ${value}`);
      complete(total) => {
        console.log(`total ${total}`);
        finished = true;
      }
    }
  }
  const over = await firstOver(31);
  console.log(`over ${over}`);
  return 0;
}
