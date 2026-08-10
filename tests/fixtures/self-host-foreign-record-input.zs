import geometry from "geometry.h";

function main(): i32 {
  let point = geometry.ZPoint({ x: 1, y: 2 });
  const translated = geometry.z_translate(point, geometry.ZForward, 3);
  const translatedScore = geometry.z_score(translated);
  geometry.z_offset(inout point, 3, 4);
  const before = geometry.z_read(point);
  geometry.z_reset(out point);
  const after = geometry.z_read(point);
  return translatedScore + translated.x + before + after;
}
