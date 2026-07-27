struct Point {
  x: i32;
  y: i32;
}

function sum(point: Point): i32 {
  return point.x + point.y;
}

function main(): i32 {
  const point: Point = Point({ x: 20, y: 22 });
  return sum(point);
}
