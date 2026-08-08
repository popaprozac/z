import { delay } from "std/time";
import { thread } from "std/thread";

enum Direction {
  increase,
  decrease,
  unchanged,
}

function chooseDirection(direction: Direction): Direction {
  return direction;
}

async function publish(
  value: i32,
  direction: Direction
): i32 on thread.main {
  let progress = value;
  match (chooseDirection(direction)) {
    increase => {
      progress = progress + 2;
      await delay(1);
      progress = progress + 1;
    }
    decrease => {
      progress = progress - 2;
      await delay(1);
      progress = progress - 1;
    }
    unchanged => {
      await delay(1);
    }
  }
  return progress;
}

async function main(): i32 on thread.main {
  const increasing = thread.spawn(async (): i32 => {
    return await on thread.main publish(40, Direction.increase);
  });
  const decreasing = thread.spawn(async (): i32 => {
    return await on thread.main publish(44, Direction.decrease);
  });
  const unchanged = thread.spawn(async (): i32 => {
    return await on thread.main publish(42, Direction.unchanged);
  });
  const increased = await increasing;
  const decreased = await decreasing;
  const same = await unchanged;
  return increased == 43 && decreased == 41 && same == 42 ? 0 : 1;
}
