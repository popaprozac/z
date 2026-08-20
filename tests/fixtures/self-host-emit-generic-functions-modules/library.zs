struct Hidden<T> {
  value: T;
}

function identity<T>(value: T): T {
  return value;
}

export function preserve<T>(value: T): T {
  return identity(value);
}

export function libraryValue(): i32 {
  const hidden = Hidden({ value: identity(20) });
  return hidden.value;
}
