import geometry from "../../../tests/fixtures/geometry.h";
import stdio from "stdio.h";

function move(point: geometry.ZPoint, amount: geometry.ZCount): geometry.ZPoint {
  return geometry.z_translate(point, geometry.ZForward, amount);
}

function nextIdentifier(identifier: geometry.ZIdentifier): geometry.ZIdentifier {
  return identifier + 1;
}

function main(): i32 {
  const origin = geometry.ZPoint({ x: 10, y: 20 });
  const moved = move(origin, 3);
  const rect = geometry.ZRect({
    origin: moved,
    size: geometry.ZSize({ width: 640, height: 480 }),
    direction: geometry.ZForward,
    flags: 7,
    identifier: nextIdentifier(41),
  });
  stdio.printf(
    "point=%d,%d width=%u flags=%u id=%llu\n",
    rect.origin.x,
    rect.origin.y,
    geometry.z_extent_value(rect.size.width),
    rect.flags,
    geometry.z_rect_id(rect)
  );
  return 0;
}
