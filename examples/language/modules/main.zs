import console from "std/console";
import geometry from "./geometry.zs";
import { translate as move } from "./geometry.zs";

function main(): i32 {
  const origin = geometry.Point({ x: 20, y: 22 });
  const moved = move(origin, 1, -1);
  console.log(`module point=${moved}, total=${geometry.total(moved)}`);
  return 0;
}
