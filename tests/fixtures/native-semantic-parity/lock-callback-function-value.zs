import console from "std/console";
import { Mutex } from "std/sync";

// A function value called inside a lock callback, with storage the lock
// guards: the callback captures the function value.
struct Runtime {
  count: u32;
}

struct State {
  runtime: Runtime;
}

function addOne(inout runtime: Runtime): void {
  runtime.count = runtime.count + 1;
}

function addTen(inout runtime: Runtime): void {
  runtime.count = runtime.count + 10;
}

function installInto(in state: Mutex<State>, install: (inout runtime: Runtime) => void): void {
  state.withLock((inout locked): void => {
    install(inout locked.runtime);
  });
}

function main(): i32 {
  const state = Mutex(State({ runtime: Runtime({ count: 0 }) }));
  installInto(in state, addOne);
  installInto(in state, addTen);
  const count = state.withLock((in locked): u32 => locked.runtime.count);
  console.log(count);
  return 0;
}
