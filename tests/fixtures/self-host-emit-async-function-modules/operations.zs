import { scheduler } from "std/async";

export async function loadValue(value: i32): i32 {
  await scheduler.yield();
  return value + 2;
}
