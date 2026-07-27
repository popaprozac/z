export struct Point {
  x: i32;
  y: i32;
}

export struct Resource {
  id: i32;

  deinit {}
}

export enum ResourceState {
  ready Resource,
  empty,
}

export function add(first: i32, second: i32): i32 {
  return first + second;
}

export function makePoint(x: i32, y: i32): Point {
  return Point({ x, y });
}

export function makeResource(id: i32): Resource {
  return Resource({ id });
}

export function makeState(id: i32): ResourceState {
  return ResourceState.ready(Resource({ id }));
}
