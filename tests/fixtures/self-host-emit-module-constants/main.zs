import values from "./values.zs";
import { DELTA as selectedDelta } from "./values.zs";
import { ratio } from "./values.zs";

function main(): i32 {
  if (!values.ENABLED) return 1;
  if (ratio() != 1.5) return 1;
  return values.BASE + selectedDelta;
}
