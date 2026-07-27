import {
  add as combine,
  makePoint as coordinate,
  makeResource as managed,
  makeState as state,
  Point as Coordinate,
  Resource as ManagedResource,
  ResourceState as State,
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

function stateId(value: State): i32 {
  return match (value) {
    ready(resource) => resource.id;
    empty => 0;
  };
}

function observeEmpty(): void {
  const value = State.empty;
}

function main(): i32 {
  const point = coordinate(20, 22);
  const resource = managed(0);
  const session = Session({ resource });
  const current = state(0);
  const direct = State.ready(managed(0));
  const empty = State.empty;
  observeEmpty();
  return combine(
    combine(
      combine(sum(point), resourceId(session)),
      stateId(current)
    ),
    combine(stateId(direct), stateId(empty))
  );
}
