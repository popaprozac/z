// Borrowed parameters of general native frames: `in`, `inout`, `out`, and
// Slice parameters point into the suspended caller's storage; a fresh `in`
// argument lives in the caller's frame until the child completes.
import console from "std/console";
import { delay } from "std/time";

struct Report {
  value: i32;
  deinit {
    console.log(`released report ${this.value}`);
  }
}

struct Reading {
  value: i32;
}

struct Counter {
  value: i32;
  function add(inout this, amount: i32): void {
    this.value = this.value + amount;
  }
}

async function inspect(in report: Report): i32 {
  await delay(1);
  console.log(`inspected ${report.value}`);
  return report.value;
}

async function bump(inout counter: Counter, amount: i32): void {
  await delay(1);
  counter.add(amount);
}

async function fill(code: i32, out reading: Reading): void {
  await delay(1);
  reading = Reading({ value: code });
}

async function relay(in report: Report): i32 {
  const seen = await inspect(report);
  return seen + 1;
}

async function total(values: Slice<i32>): i32 {
  await delay(1);
  return values[0] + values[1];
}

async function main(): i32 {
  const report = Report({ value: 40 });
  const seen = await inspect(report);
  let counter = Counter({ value: 1 });
  await bump(inout counter, 2);
  let filled: Reading;
  await fill(7, out filled);
  const relayed = await relay(report);
  const temporary = await inspect(Report({ value: 5 }));
  async scope {
    task inspect(report);
  }
  let numbers = Array<i32>();
  numbers.push(20);
  numbers.push(22);
  const sum = await total(numbers);
  console.log(`seen ${seen} counter ${counter.value} filled ${filled.value} relayed ${relayed} temporary ${temporary} sum ${sum}`);
  return seen - 40 + counter.value - 3 + filled.value - 7 + relayed - 41 + temporary - 5 + sum - 42;
}
