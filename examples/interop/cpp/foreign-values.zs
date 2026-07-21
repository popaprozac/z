import console from "std/console";
import native from "../../../tests/fixtures/foreign-values.hpp";

struct NativeOwner {
  value: native.zcpp.ManagedValue;
}

function exercise(): i32 {
  const first = native.zcpp.make_managed(40);
  const owner = NativeOwner({ value: first });
  let copied = owner;
  copied.value.add(2);
  return copied.value.value();
}

function main(): i32 {
  const answer = exercise();
  const live = native.zcpp.managed_live();
  console.log(`answer=${answer}, copies=${native.zcpp.managed_copies()}, drops=${native.zcpp.managed_drops()}, live=${live}`);
  return live;
}
