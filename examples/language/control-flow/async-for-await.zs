import console from "std/console";
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

async function readings(): AsyncGenerator<i32> {
  yield 20;
  await delay(1);
  yield 0;
  yield 22;
}

async function main(): i32 {
  let total = 0;
  for await (const reading of readings()) {
    await delay(1);
    if (reading == 0) continue;
    total = total + reading;
  }

  const stored = readings();
  for await (const reading of stored) {
    total = total + reading;
    break;
  }

  const next = await stored.next();
  const resumed = match (next) {
    some(value) => value;
    none => -1;
  };

  console.log(`for await total=${total}, resumed=${resumed}`);
  return total + resumed - 62;
}
