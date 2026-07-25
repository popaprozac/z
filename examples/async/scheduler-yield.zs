import console from "std/console";
import { scheduler } from "std/async";

async function firstJob(): i32 {
  console.log("first: start");
  await scheduler.yield();
  await scheduler.yield();
  console.log("first: finish");
  return 20;
}

async function secondJob(): i32 {
  console.log("second: start");
  await scheduler.yield();
  console.log("second: finish");
  return 22;
}

async function main(): i32 {
  const first = task firstJob();
  const second = task secondJob();
  const firstValue = await first;
  const secondValue = await second;
  return firstValue + secondValue - 42;
}
