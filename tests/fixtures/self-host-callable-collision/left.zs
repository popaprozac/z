struct Payload {
  value: i32;
}

type Handler = (in payload: Payload) => i32;

function read(in payload: Payload): i32 {
  return payload.value + 1;
}

export function runLeft(value: i32): i32 {
  const handler: Handler = read;
  const payload = Payload({ value });
  return handler(in payload);
}
