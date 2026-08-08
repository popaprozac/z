import { delay } from "std/time";
import { thread } from "std/thread";

async function publish(value: i32, increase: boolean): i32 on thread.main {
  let progress = value;
  if (increase) {
    progress = progress + 2;
    await delay(1);
    progress = progress + 1;
  } else {
    progress = progress - 2;
    await delay(1);
    progress = progress - 1;
  }
  return progress;
}

async function main(): i32 on thread.main {
  const increasing = thread.spawn(async (): i32 => {
    return await on thread.main publish(40, true);
  });
  const decreasing = thread.spawn(async (): i32 => {
    return await on thread.main publish(44, false);
  });
  const increased = await increasing;
  const decreased = await decreasing;
  return increased == 43 && decreased == 41 ? 0 : 1;
}
