import console from "std/console";
import { createLeft } from "./private-aggregate-left.zs";
import { createRight } from "./private-aggregate-right.zs";

function exercise(): i32 {
  const left = createLeft();
  const right = createRight();
  if (left.rows[0][0].value != 42) return 1;
  if (right.items[0].value != 300) return 2;
  if (left.rows[0][0].label != "left" || right.items[0].label != "right") return 3;
  if (right.items[0].extra[0] != "nested") return 4;
  const retained = copy right.items[0].label;
  if (retained != "right") return 5;
  return 0;
}

function main(): i32 {
  const result = exercise();
  console.log("done");
  return result;
}
