import native from "native-union.h";

function main(): i32 {
  let event;
  if (!native.z_native_poll(out event)) return 1;

  const eventType = unsafe {
    select event.type;
  };
  return eventType - 42;
}
