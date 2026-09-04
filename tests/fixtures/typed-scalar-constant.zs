import geometry from "./geometry.h";

function main(): i32 {
  const amount: geometry.ZCount = geometry.ZCountDefault;
  const widened = i64(geometry.ZCountDefault);
  const point = geometry.ZPoint({ x: 20, y: 19 });
  const moved = geometry.z_translate(point, geometry.ZForward, amount);
  return moved.x - 20 - i32(widened);
}
