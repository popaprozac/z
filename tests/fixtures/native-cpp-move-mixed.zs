// A struct with both Z cleanup (String) and a move-only C++ member, moved on
// one path only: the Z liveness flag and the C++ move must happen together.
import console from "std/console";
import native from "move-only.hpp";

struct Labeled {
  label: String;
  value: native.zcpp.UniqueValue;
}

function consume(item: Labeled): i32 {
  return item.value.value() + i32(item.label.byteLength);
}

function exercise(flag: boolean): i32 {
  const first = Labeled({ label: `dynamic ${"label"}`, value: native.zcpp.UniqueValue(40) });
  if (flag) {
    return consume(first);
  }
  return 1;
}

function main(): i32 {
  const taken = exercise(true);
  const kept = exercise(false);
  console.log(`taken=${taken} kept=${kept} moves=${native.zcpp.unique_moves()} live=${native.zcpp.unique_live()}`);
  return 0;
}
