import console from "std/console";
import { zcpp } from "../../../tests/fixtures/move-only.hpp";

enum NativeState {
  ready zcpp.UniqueValue,
  empty,
}

struct LabeledValue {
  label: String;
  value: zcpp.UniqueValue;
}

enum LabeledState {
  ready LabeledValue,
  empty,
}

function inspect(in state: NativeState): i32 {
  return match (in state) {
    ready(value) => value.value();
    empty => -1;
  };
}

function consume(state: NativeState): i32 {
  return match (state) {
    ready(value) => value.value();
    empty => -1;
  };
}

function consumeLabeled(state: LabeledState): i32 {
  return match (state) {
    ready(value) => value.value.value();
    empty => -1;
  };
}

function exercise(): i32 {
  const state = NativeState.ready(zcpp.UniqueValue(42));
  const observed = inspect(state);
  let replaced = NativeState.ready(zcpp.UniqueValue(1));
  replaced = NativeState.ready(zcpp.UniqueValue(2));
  const replacement = consume(replaced);
  let labeled = LabeledState.ready(LabeledValue({
    label: "replaced",
    value: zcpp.UniqueValue(5),
  }));
  labeled = LabeledState.ready(LabeledValue({
    label: "owned",
    value: zcpp.UniqueValue(7),
  }));
  return consume(state) + observed + replacement + consumeLabeled(labeled) - 51;
}

function main(): i32 {
  const answer = exercise();
  const moves = zcpp.unique_moves();
  const live = zcpp.unique_live();
  console.log(`enum answer=${answer}, moves=${moves}, live=${live}`);
  return live;
}
