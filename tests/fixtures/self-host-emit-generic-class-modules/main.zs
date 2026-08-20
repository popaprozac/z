import { Cell as SharedCell } from "./library.zs";
import { privateStatus } from "./private-cell.zs";

function main(): i32 {
  let cell = new SharedCell<String>({ value: "first", marker: 3 });
  cell.replace("ready");
  const shared = cell;
  if (shared.value != "ready" || cell.value != "ready") return 1;
  return privateStatus();
}
