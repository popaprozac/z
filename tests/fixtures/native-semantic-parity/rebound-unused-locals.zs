import console from "std/console";
struct State {
  count: i32;
  function increment(inout this): boolean { this.count = this.count + 1; return true; }
}
struct Token { value: i32; deinit { console.log(`${this.value}`); } }
function run(inout state: State, early: boolean): i32 {
  if (early) {
    const ok = state.increment();
    const token = Token({ value: 1 });
    return 1;
  }
  let ok = state.increment();
  const token = Token({ value: 2 });
  if (ok) { ok = false; return token.value; }
  return 3;
}
function main(): i32 {
  let state = State({ count: 0 });
  if (run(inout state, true) != 1) return 1;
  if (run(inout state, false) != 2) return 2;
  if (state.count != 2) return 3;
  console.log("ok");
  return 0;
}
