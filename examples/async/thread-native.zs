import console from "std/console";
import { thread } from "std/thread";
import native from "../../tests/fixtures/move-only.hpp";

async function main(): i32 {
  const measurement = native.zcpp.UniqueValue(42);
  const calculation = thread.spawn(move () => measurement.value());
  // measurement is unavailable here: its unique native owner moved to the thread.

  const answer = await calculation;
  console.log(`native thread answer=${answer}`);
  return answer - 42;
}
