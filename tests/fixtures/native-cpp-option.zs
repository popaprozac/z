// Option of a move-only C++ value: construction, Array.pop, and consuming and
// borrowed matches, with every value destroyed once.
import console from "std/console";
import native from "move-only.hpp";

function pick(flag: boolean): Option<native.zcpp.UniqueValue> {
  if (flag) return Option.some(native.zcpp.UniqueValue(9));
  return Option<native.zcpp.UniqueValue>.none;
}

function exercise(): i32 {
  let values = Array<native.zcpp.UniqueValue>();
  values.push(native.zcpp.UniqueValue(42));
  const removed = values.pop();
  const picked = pick(true);
  const missing = pick(false);
  const first = match (removed) {
    some(value) => value.value();
    none => 0;
  };
  const second = match (in picked) {
    some(value) => value.value();
    none => 0;
  };
  const third = match (missing) {
    some(value) => value.value();
    none => 1;
  };
  return first + second + third;
}

function main(): i32 {
  const total = exercise();
  console.log(`total=${total} live=${native.zcpp.unique_live()}`);
  return 0;
}
