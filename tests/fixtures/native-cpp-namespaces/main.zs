import console from "std/console";
import shapes from "shapes.hpp";
import { geometry as g, labels } from "shapes.hpp";

function main(): i32 {
  const point: shapes.geometry.Point = shapes.geometry.Point({ x: 6, y: 7 });
  const label = labels.Point({ id: 4 });
  const narrow: i32 = shapes.widen(21);
  const wide: f64 = g.widen(2.0);
  const signed: i64 = g.pick(i64(5));
  const unsigned: u64 = shapes.geometry.pick(u64(5));
  const deep = shapes.geometry.inner.depth(1) + g.inner.depth(2);
  console.log(`area=${shapes.area(point)} tag=${labels.tag(label)} narrow=${narrow} wide=${wide}`);
  console.log(`signed=${signed} unsigned=${unsigned} deep=${deep} local=${g.area(g.Point({ x: 2, y: 3 }))}`);
  return 0;
}
