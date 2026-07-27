import {
  add as combine,
  makePoint as coordinate,
  makeResource as managed,
  Point as Coordinate,
  Resource as ManagedResource,
} from "./math.zs";

function sum(point: Coordinate): i32 {
  return point.x + point.y;
}

function resourceId(resource: ManagedResource): i32 {
  return resource.id;
}

function main(): i32 {
  const point = coordinate(20, 22);
  const resource = managed(0);
  return combine(sum(point), resourceId(resource));
}
