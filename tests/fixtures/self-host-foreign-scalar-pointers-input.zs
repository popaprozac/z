import native from "scalar-pointers.h";

function readChecked(): i32 throws i32 {
  let x;
  let y;
  try native.z_mouse_state_checked(out x, out y);
  if (x != 12.5) return 1;
  if (y != 7.25) return 2;
  return 0;
}

function main(): i32 {
  let x;
  let y;
  const buttons = native.z_mouse_state(out x, out y);
  if (buttons != 3) return 1;
  native.z_increment_float(inout x);
  if (native.z_read_float(in x) != 13.5) return 2;
  if (y != 7.25) return 3;
  const checked = attempt readChecked();
  return match (checked) {
    success(value) => value;
    failure(status) => status;
  };
}
