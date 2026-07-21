import console from "std/console";
import native from "../../../tests/fixtures/move-only.hpp";

struct NativeOwner {
  value: native.zcpp.UniqueValue;
}

function inspect(in value: native.zcpp.UniqueValue): i32 {
  return value.value();
}

function relay(value: native.zcpp.UniqueValue): native.zcpp.UniqueValue {
  return value;
}

function exercise(): i32 {
  const first = native.zcpp.UniqueValue(40);
  const observed = inspect(first);
  const second = relay(first);
  const owner = NativeOwner({ value: second });
  const moved = owner;
  return observed + moved.value.value() - 38;
}

function main(): i32 {
  const answer = exercise();
  const moves = native.zcpp.unique_moves();
  const live = native.zcpp.unique_live();
  console.log(`answer=${answer}, moves=${moves}, live=${live}`);
  return live;
}
