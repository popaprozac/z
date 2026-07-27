import {
  add as combine,
  makePoint as coordinate,
  makeResource as managed,
  Point as Coordinate,
  Resource as ManagedResource,
} from "./math.zs";

struct Session {
  resource: ManagedResource;
}

function sum(point: Coordinate): i32 {
  return point.x + point.y;
}

function resourceId(session: Session): i32 {
  return session.resource.id;
}

function main(): i32 {
  const point = coordinate(20, 22);
  const resource = managed(0);
  const session = Session({ resource });
  return combine(sum(point), resourceId(session));
}
