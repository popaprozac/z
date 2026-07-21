import geometry from "../../../tests/fixtures/geometry.h";
import stdio from "stdio.h";

function main(): i32 {
  let point = geometry.ZPoint({ x: 1, y: 2 });
  geometry.z_offset(inout point, 3, 4);
  const before = geometry.z_read(point);
  geometry.z_reset(out point);
  const after = geometry.z_read(point);
  stdio.printf(
    "before=%d after=%d point=%d,%d\n",
    before,
    after,
    point.x,
    point.y
  );
  return 0;
}
