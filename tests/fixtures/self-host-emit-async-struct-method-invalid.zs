import { scheduler } from "std/async";

struct Counter {
  value: i32;

  async function read(): i32 {
    await scheduler.yield();
    return this.value;
  }
}

async function main(): i32 {
  const counter = Counter({ value: 42 });
  return await counter.read();
}
