import { expect } from "std/test";

test "unsigned expected value is formatted without truncation" {
  const actual: u64 = 0;
  expect(actual).toEqual(0xFFFF_FFFF_FFFF_FFFF);
}

test "unsigned actual literal is formatted without truncation" {
  const expected: u64 = 0;
  expect(0xFFFF_FFFF_FFFF_FFFF).toEqual(expected);
}

test "signed expected value is formatted without truncation" {
  const actual: i64 = 0;
  expect(actual).toEqual(-9223372036854775808);
}
