import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";

// A placed block's undeclared captures are private snapshots: a String or a
// cleanup-free value (scalars, fixed arrays, structs, enums, Option).

struct Point {
  x: i32;
  y: i32;
}

enum Shape {
  dot Point,
  empty,
}

async function summarize(): i32 {
  const label = "sum";
  const point = Point({ x: 1, y: 2 });
  const shape = Shape.dot(Point({ x: 3, y: 4 }));
  const maybe = Option<i32>.some(5);
  const fixed = [6, 7, 8];
  await delay(1);
  const total = await on thread.main: i32 {
    const fromShape = match (shape) {
      dot(inner) => inner.x + inner.y;
      empty => 0;
    };
    const fromOption = match (maybe) {
      some(value) => value;
      none => 0;
    };
    console.log(`${label} ${point.x + point.y} ${fromShape} ${fromOption} ${fixed[0] + fixed[2]}`);
    select point.x + point.y + fromShape + fromOption + fixed[0] + fixed[2];
  };
  return total;
}

async function main(): i32 {
  const total = await summarize();
  console.log(`total ${total}`);
  return total - 29;
}
