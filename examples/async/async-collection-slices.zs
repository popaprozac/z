import console from "std/console";
import { delay } from "std/time";

struct Sensor {
  id: i32;

  deinit {
    console.log(`released sensor ${this.id}`);
  }
}

async function totalAfterDelay(readings: Slice<i32>): i32 {
  await delay(1);
  return readings[0] + readings[1] + readings[2];
}

async function firstSensorAfterDelay(sensors: Slice<Sensor>): i32 {
  await delay(1);
  return sensors[0].id;
}

async function main(): i32 {
  let readings = Array<i32>();
  readings.push(10);
  readings.push(12);
  readings.push(18);

  let registered = Array<Sensor>();
  registered.push(Sensor({ id: 7 }));
  registered.push(Sensor({ id: 9 }));

  async scope {
    const abandonedScan = task firstSensorAfterDelay(registered);
    await abandonedScan.cancel();
  }

  registered.push(Sensor({ id: 10 }));
  const readingTotal = await totalAfterDelay(readings);
  const registeredId = await firstSensorAfterDelay(registered);

  const fallback = [Sensor({ id: 11 }), Sensor({ id: 13 })];
  let fallbackId = 0;
  async scope {
    const fallbackScan = task firstSensorAfterDelay(fallback);
    fallbackId = await fallbackScan;
  }

  console.log(`total=${readingTotal}, registered=${registeredId}, fallback=${fallbackId}`);
  return readingTotal - 40 + registeredId - 7 + fallbackId - 11;
}
