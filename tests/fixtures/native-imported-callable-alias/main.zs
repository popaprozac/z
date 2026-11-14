import console from "std/console";
// CommandAction aliases an `as`-renamed import of another module's callable alias.
import { CommandAction } from "./api.zs";

function run(in action: CommandAction): i32 {
  return action(20);
}

function main(): i32 {
  const offset = 22;
  const action: CommandAction = move (value: i32): i32 => value + offset;
  const direct = action(1);
  console.log(`direct ${direct} run ${run(action)}`);
  return 0;
}
