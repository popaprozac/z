import { runLeft } from "./left.zs";
import { runRight } from "./right.zs";

function main(): i32 {
  return runLeft(19) + runRight(20) - 42;
}
