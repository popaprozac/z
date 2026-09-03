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
  const unsignedWide = u64(wideSigned);
  const signedAgain = i64(unsignedWide);
  if (unsignedWide != 2 || signedAgain != wideSigned) return 1;
  let wideMaximum: i64 = 9223372036854775807;
  const wideReduced = (wideMaximum - i64(9)) / i64(10);
  if (wideReduced != 922337203685477579) return 1;
  const wideProduct = wideSigned * i64(10) + i64(9);
  if (wideProduct != 29) return 1;
  let wideMinimum = -wideMaximum;
  wideMinimum = wideMinimum - i64(1);
  if (wideMinimum >= 0) return 1;
  const narrowedWide = i32(wideSigned);
  const minimum: i32 = -2147483648;
  if (minimum >= 0) return 1;
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
    + narrowedWide
    - 513;
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
