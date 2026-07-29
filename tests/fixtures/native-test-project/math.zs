import { expect } from "std/test";

export function add(left: i32, right: i32): i32 {
  return left + right;
}

test "imported module tests are discovered" {
  expect(add(6, 7)).toEqual(13);
}
