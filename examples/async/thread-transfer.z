import console from "std/console";
import { thread } from "std/thread";

async function main(): i32 {
  let parentCounter = 20;
  const copied = thread.spawn(move (): i32 => {
    parentCounter = parentCounter + 22;
    return parentCounter;
  });

  // Cleanup-free values are copied into the closure, so this remains 20.
  console.log(`parent copy remains=${parentCounter}`);

  let readings = Array<i32>();
  readings.push(20);
  readings.push(22);
  const moved = thread.spawn(move () => readings[0] + readings[1]);
  // readings is unavailable here: its backing storage moved to the thread.

  const copiedAnswer = await copied;
  const movedAnswer = await moved;
  console.log(`thread copy=${copiedAnswer}, moved owner=${movedAnswer}`);
  return copiedAnswer + movedAnswer - 84;
}
