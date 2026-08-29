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

export function integerParity(value: u8): i32 {
  const widened = usize(value);
  const signed = i32(widened);
  const wideSigned = i64(signed);
  if (wideSigned != 2) return 1;
  const native = usize(signed);
  const narrowed = u8(native);
  const maximum: u8 = 255;
  const wrappedAdd = maximum.wrappingAdd(1);
  const wrappedSubtract = wrappedAdd.wrappingSubtract(1);
  const wrappedMultiply = maximum.wrappingMultiply(2);
  return i32(wrappedAdd)
    + i32(wrappedSubtract)
    + i32(wrappedMultiply)
    + i32(narrowed)
    - 511;
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
