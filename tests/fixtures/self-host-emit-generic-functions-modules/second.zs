function identity<T>(value: T): T {
  return value;
}

export function secondValue(): i32 {
  return identity(22);
}
