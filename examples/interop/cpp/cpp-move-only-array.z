import console from "std/console";
import { zcpp } from "../../../tests/fixtures/move-only.hpp";

struct LabeledValue {
  label: String;
  value: zcpp.UniqueValue;
}

function makeValues(): Array<zcpp.UniqueValue> {
  let values = Array<zcpp.UniqueValue>();
  let index: i32 = 0;
  while (index < 6) {
    values.push(zcpp.UniqueValue(index + 20));
    index = index + 1;
  }
  return values;
}

function exercise(): i32 {
  const values = makeValues();

  let labeled = Array<LabeledValue>();
  labeled.push(LabeledValue({ label: "owned", value: zcpp.UniqueValue(7) }));

  return values[0].value() + values[5].value() + labeled[0].value.value() - 10;
}

function main(): i32 {
  const answer = exercise();
  const moves = zcpp.unique_moves();
  const live = zcpp.unique_live();
  console.log(`array answer=${answer}, moves=${moves}, live=${live}`);
  return live;
}
