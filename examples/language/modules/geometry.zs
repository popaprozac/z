import { add } from "./math.zs";

export struct Point {
  x: i32;
  y: i32;
}

export function translate(in point: Point, dx: i32, dy: i32): Point {
  return Point({ x: add(point.x, dx), y: add(point.y, dy) });
}

export function total(in point: Point): i32 {
  return add(point.x, point.y);
}
