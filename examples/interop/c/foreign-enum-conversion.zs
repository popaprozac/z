import geometry from "../../../tests/fixtures/geometry.h";

function main(): i32 {
  const direction = i32(geometry.ZForward);
  if (direction != 1) return 1;
  return 0;
}
