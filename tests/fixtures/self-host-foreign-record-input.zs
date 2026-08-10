import geometry from "geometry.h";

function main(): i32 {
  let point = geometry.ZPoint({ x: 1, y: 2 });
  const translated = geometry.z_translate(point, geometry.ZForward, 3);
  const translatedScore = geometry.z_score(translated);
  const rect = geometry.ZRect({
    origin: translated,
    size: geometry.ZSize({ width: 640, height: 480 }),
    flags: 7,
    identifier: 42,
  });
  const identifier = geometry.z_rect_id(rect);
  geometry.z_offset(inout point, 3, 4);
  const before = geometry.z_read(point);
  geometry.z_reset(out point);
  const after = geometry.z_read(point);
  if (identifier != 42) return 90;
  return translatedScore + translated.x + before + after;
}
