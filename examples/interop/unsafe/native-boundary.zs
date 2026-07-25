import console from "std/console";
import native from "../../../tests/fixtures/unsafe-native.h";

function main(): i32 {
  const version = unsafe {
    const borrowed: cstring = native.z_unsafe_version();
    select String.from(borrowed);
  };

  const observed = unsafe {
    const handle = native.z_unsafe_open(42);

    if (handle == null) return 1;

    const value = native.z_unsafe_read(handle);
    native.z_unsafe_close(handle);
    select value;
  };

  console.log(`unsafe version=${version}, observed=${observed}`);
  return observed - 42;
}
