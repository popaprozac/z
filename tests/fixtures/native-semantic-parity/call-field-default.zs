import console from "std/console";
import { Record, Tally, emptyRecord as freshRecord } from "./call-field-default-library.zs";

// A struct field's default calls a function: the module's own, one it
// imports (under another name), and, through an imported struct, one of the
// struct's own module. The native compiler emits each callee's own name.
function localCount(): u32 {
  return 7;
}

struct Holder {
  id: u32;
  count: u32 = localCount();
  record: Record = freshRecord();
}

function main(): i32 {
  let holder = Holder({ id: 1 });
  holder.record.names.push(2);
  const tally = Tally({ id: 2 });
  console.log(holder.count, holder.record.names.length, tally.count, tally.record.names.length);
  return 0;
}
