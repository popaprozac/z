import console from "std/console";
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

struct ReadError {
  code: i32;
}

async function readings(fail: boolean): AsyncGenerator<i32, void, ReadError> throws ReadError {
  yield 20;
  await delay(1);
  if (fail) throw ReadError({ code: 7 });
  yield 22;
}

async function collect(fail: boolean): i32 throws ReadError {
  let total = 0;
  try for await (const reading of readings(fail)) {
    console.log(`received ${reading}`);
    total = total + reading;
  }
  return total;
}

async function main(): i32 {
  const completed = attempt await collect(false);
  const total = match (completed) {
    success(value) => value;
    failure(error) => 0;
  };
  const failed = attempt await collect(true);
  const code = match (failed) {
    success(value) => 0;
    failure(error) => error.code;
  };
  return total + code - 49;
}
