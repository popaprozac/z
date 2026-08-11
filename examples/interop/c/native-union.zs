import native from "../../../tests/fixtures/native-union.h";

function main(): i32 {
  let event;
  if (!native.z_native_poll(out event)) return 1;

  const observed = match (in event) {
    idle => 0;
    value(value) => value.value;
    text(input) => input.sequence;
    other(type) => type;
  };
  return observed - 42;
}
