import { scheduler } from "std/async";

async function measure(self: String): i32 {
  await scheduler.yield();
  return i32(self.byteLength);
}

class Store {
  text: String;
  constructor(self: String) { this.text = move self; }
  function measure(self: String): usize {
    return this.text.byteLength + self.byteLength;
  }
}

async function main(): i32 {
  const self = "frame";
  const store = new Store("stored");
  const count = await measure(copy self);
  await scheduler.yield();
  if (count != 5 || self.byteLength != 5) return 1;
  if (store.measure("argument") != 14) return 2;
  return 0;
}
