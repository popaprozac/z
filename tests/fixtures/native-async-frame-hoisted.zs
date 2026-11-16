// Awaits nested in expressions run first, in evaluation order, into frame
// temporaries: match subjects, operands, assignment values, task joins, and
// if conditions.
import console from "std/console";
import { delay } from "std/time";

struct NetworkError {
  code: i32;
}

async function fetchValue(id: i32): i32 throws NetworkError {
  await delay(1);
  if (id < 0) throw NetworkError({ code: -id });
  return id;
}

async function isExpected(value: i32): boolean {
  await delay(1);
  return value == 42;
}

async function double(value: i32): i32 {
  await delay(1);
  return value * 2;
}

async function main(): i32 {
  const baseline = match (attempt await fetchValue(0)) {
    success(value) => value;
    failure(error) => -error.code;
  };
  const missing = match (attempt await fetchValue(-3)) {
    success(value) => value;
    failure(error) => -error.code;
  };
  const sum = (await double(10)) + (await double(11));
  let total: i32 = 0;
  total = await double(sum) - 42;
  const pending = task double(3);
  let joined: i32 = 0;
  joined = await pending;
  console.log(`baseline ${baseline} missing ${missing} sum ${sum} total ${total} joined ${joined}`);
  if (await isExpected(sum)) {
    console.log("expected");
  }
  if (await isExpected(total)) {
    console.log("unexpected");
  } else {
    console.log("other");
  }
  return baseline + missing + 3 + sum - 42 + total - 42 + joined - 6;
}
