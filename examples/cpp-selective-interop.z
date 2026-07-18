import console from "std/console";
import { zcpp as math, alpha as left, beta as right } from "cpp_math.hpp";

function main(): i32 {
  const origin = math.Point({ x: 20, y: 22 });
  const moved = math.translate(origin, 1, -1);
  const leftPoint = left.Point({ value: 20 });
  const rightPoint = right.Point({ value: 20 });
  const adjusted = left.adjust(leftPoint.value) + right.adjust(rightPoint.value);
  console.log(`selective cpp=${math.sum(moved)}, adjusted=${adjusted}`);
  return 0;
}
