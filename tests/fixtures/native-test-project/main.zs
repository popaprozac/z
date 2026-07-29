import { expect } from "std/test";
import { add } from "./math.zs";

test "entry module expectations run" {
  const answer = add(20, 22);
  expect(in answer).toEqual(42);
  expect("ready").toEqual("ready");
  const wide: u64 = 42;
  const expectedWide: u64 = 42;
  expect(wide).toEqual(expectedWide);
  const ratio: f64 = 2.5;
  const expectedRatio: f64 = 2.5;
  expect(ratio).toEqual(expectedRatio);
}
