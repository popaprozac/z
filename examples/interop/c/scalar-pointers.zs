import native from "../../../tests/fixtures/scalar-pointers.h";

function main(): i32 {
  let x;
  let y;
  const buttons = native.z_mouse_state(out x, out y);

  native.z_increment_float(inout x);
  const observed = native.z_read_float(x);
  if (buttons != 3) return 1;
  if (observed != 13.5) return 2;
  if (y != 7.25) return 3;
  return 0;
}
