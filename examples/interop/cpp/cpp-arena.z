import console from "std/console";
import { Arena } from "std/memory";
import { zcpp } from "../../../tests/fixtures/move-only.hpp";

function inspect(in value: zcpp.UniqueValue): i32 {
  return value.value();
}

function main(): i32 {
  let scratch = Arena();
  const left = scratch.create(zcpp.UniqueValue(20));
  const right = scratch.create(zcpp.UniqueValue(22));

  const answer = inspect(left) + right.value();
  const liveBeforeReset = zcpp.unique_live();
  scratch.reset();
  const liveAfterReset = zcpp.unique_live();

  console.log(`arena answer=${answer}, live before=${liveBeforeReset}, live after=${liveAfterReset}`);
  return answer - 42 + liveBeforeReset - 2 + liveAfterReset;
}
