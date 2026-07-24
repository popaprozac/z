import console from "std/console";
import { delay } from "std/time";

function calibrate(inout readings: Slice<i32>, adjustment: i32): void {
  readings[0] = readings[0] + adjustment;
  readings[1] = readings[1] + adjustment;
  readings[2] = readings[2] + adjustment;
}

async function totalAfterDelay(readings: Slice<i32>): i32 {
  await delay(1);
  return readings[0] + readings[1] + readings[2];
}

async function calibrateAfterDelay(inout readings: Slice<i32>, adjustment: i32): void {
  await delay(1);
  calibrate(inout readings, adjustment);
}

async function main(): i32 {
  let readings = [10, 12, 18];
  const originalTotal = await totalAfterDelay(readings);

  async scope {
    const calibration = task calibrateAfterDelay(inout readings, 2);
    console.log("calibration started");
    await calibration;
  }

  const calibratedTotal = await totalAfterDelay(readings);
  console.log(`original=${originalTotal}, calibrated=${calibratedTotal}`);
  return originalTotal - 40 + calibratedTotal - 46;
}
