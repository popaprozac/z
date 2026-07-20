import console from "std/console";
import { delay } from "std/time";

struct SensorReading {
  sensorId: i32;
  celsius: i32;
}

async function readSensorAfter(sensorId: i32, out reading: SensorReading): void {
  await delay(1);
  reading = SensorReading({ sensorId, celsius: 22 });
  await delay(1);
}

async function main(): i32 {
  let reading: SensorReading;
  await readSensorAfter(20, out reading);

  console.log(`sensor=${reading.sensorId}, celsius=${reading.celsius}`);
  return reading.sensorId - 20 + reading.celsius - 22;
}
