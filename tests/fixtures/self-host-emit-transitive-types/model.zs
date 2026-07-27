export struct Payload {
  value: i32;
}

export struct Wrapper {
  item: Option<Payload>;
}

export function makeWrapper(value: i32): Wrapper {
  return Wrapper({
    item: Option<Payload>.some(Payload({ value })),
  });
}
