import console from "std/console";
import { Operation, add, apply } from "./operations.zs";

function main(): i32 {
  const operation: Operation = add;
  const answer = apply(operation, 20, 22);
  console.log(`aliased callback answer=${answer}`);
  return answer == 42 ? 0 : 1;
}
