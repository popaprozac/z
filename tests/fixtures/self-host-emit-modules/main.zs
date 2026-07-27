import {
  add as combine,
  makePoint as coordinate,
  Point as Coordinate,
} from "./math.zs";

function sum(point: Coordinate): i32 {
  return point.x + point.y;
}

function main(): i32 {
  const point = coordinate(20, 22);
  return combine(sum(point), 0);
}
