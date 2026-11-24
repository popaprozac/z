import console from "std/console";
import { delay } from "std/time";

// Async methods that write through `inout this`, and async methods that
// await other methods on `this`: awaited directly, from another function,
// through a field, as a task, and with a failure.

enum Failure { broken }

class Counter {
  total: i32;

  async function peek(): i32 {
    await delay(1);
    return this.total;
  }

  async function both(): i32 {
    const first = await this.peek();
    const second = await this.peek();
    return first + second;
  }

  async function bump(inout this, by: i32): i32 {
    await delay(1);
    this.total = this.total + by;
    return this.total;
  }

  async function twice(inout this, by: i32): i32 {
    const first = await this.bump(by);
    const second = await this.bump(by);
    return first + second;
  }

  async function checked(inout this, by: i32): i32 throws Failure {
    await delay(1);
    if (by < 0) throw Failure.broken;
    this.total = this.total + by;
    return this.total;
  }
}

class Holder {
  counter: Counter;
}

async function drive(counter: Counter): i32 {
  const sum = await counter.twice(10);
  return sum;
}

async function main(): i32 {
  let counter = new Counter({ total: 1 });
  const bumped = await counter.bump(4);
  const doubled = await counter.twice(2);
  console.log(`bump ${bumped} twice ${doubled} total ${counter.total}`);
  console.log(`both ${await counter.both()}`);
  const accepted = attempt await counter.checked(1);
  const rejected = attempt await counter.checked(-1);
  match (accepted) {
    success(value) => console.log(`checked ${value}`);
    failure(_) => console.log("checked failed");
  }
  match (rejected) {
    success(value) => console.log(`checked ${value}`);
    failure(_) => console.log("checked failed");
  }
  const driven = await drive(counter);
  console.log(`drive ${driven} total ${counter.total}`);
  async scope {
    const pending = task counter.bump(5);
    const joined = await pending;
    console.log(`task ${joined}`);
  }
  let holder = new Holder({ counter: new Counter({ total: 100 }) });
  const held = await holder.counter.bump(1);
  console.log(`field ${held} total ${holder.counter.total}`);
  return 0;
}
