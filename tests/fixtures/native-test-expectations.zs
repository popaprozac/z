import { expect, fail } from "std/test";

test "native parser sees expectations" {
  const answer = 42;
  expect(in answer).toEqual(42);
}

test "native runner reports expectation failures" {
  const observed = 41;
  expect(observed).toEqual(42);
}

test "native parser sees explicit failure" {
  fail("deliberate fixture failure");
}

test "native runner continues after failure" {
  return;
}

function main(): i32 {
  return 0;
}
