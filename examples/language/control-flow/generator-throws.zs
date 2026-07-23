import console from "std/console";
import { Generator } from "std/iteration";

struct ReadError {
  code: i32;
}

function readValues(failAfterFirst: boolean): Generator<i32> throws ReadError {
  yield 20;
  if (failAfterFirst) {
    throw ReadError({ code: 7 });
  }
  yield 22;
}

function consume(values: Generator<i32, void, ReadError>): i32 throws ReadError {
  const first = try values.next();
  const firstValue = match (first) {
    some(value) => value;
    none => 0;
  };

  const second = try values.next();
  const secondValue = match (second) {
    some(value) => value;
    none => 0;
  };

  return firstValue + secondValue;
}

function main(): i32 {
  const completed = attempt consume(readValues(false));
  match (completed) {
    success(value) => console.log(`completed ${value}`);
    failure(error) => console.log(`unexpected ${error.code}`);
  }

  const failed = attempt consume(readValues(true));
  return match (failed) {
    success(value) => 1;
    failure(error) => {
      console.log(`failed ${error.code}`);
      select error.code - 7;
    }
  };
}
