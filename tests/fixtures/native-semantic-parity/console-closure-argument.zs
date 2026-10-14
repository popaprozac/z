import console from "std/console";
import { Mutex } from "std/sync";

// A closure inside a console argument, a template part included, is lowered
// before the value prints.
function main(): i32 {
  const state = Mutex(u32(3));
  console.log(state.withLock((in value): u32 => value));
  console.log("held", state.withLock((in value): u32 => value + 1), `after ${state.withLock((in value): u32 => value * 2)}`);
  return 0;
}
