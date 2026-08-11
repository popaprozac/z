import native from "native-union.h";

function main(): i32 {
  let event;
  if (!native.z_native_poll(out event)) return 1;

  const eventType = match (in event) {
    idle => 0;
    value(value) => value.value;
    text(input) => {
      const text = input.text;
      if (text == null) return 2;
      select input.sequence;
    }
    other(type) => type;
  };
  return eventType - 42;
}
