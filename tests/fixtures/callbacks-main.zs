import callbacks from "callbacks.h";
import stdio from "stdio.h";

struct EscapedResource {
  offset: i32;

  deinit {
    stdio.printf("escape-drop=%d\n", this.offset);
  }
}

function multiply(left: i32, right: i32): i32 {
  return left * right;
}

function installEscapingCallback(): void {
  const resource = EscapedResource({ offset: 2 });
  const escaped: (value: i32) => i32 =
    move (value: i32): i32 => value + resource.offset;
  callbacks.z_register_context_callback(escaped);
}

function main(): i32 {
  const operation = multiply;
  const add: (left: i32, right: i32) => i32 =
    (left: i32, right: i32): i32 => left + right;
  const product = callbacks.z_apply_i32(6, 7, operation);
  const incremented = callbacks.z_apply_twice_i32(40, add);
  const offset = 2;
  const addOffset: (value: i32) => i32 =
    move (value: i32): i32 => value + offset;
  const captured = callbacks.z_apply_context_i32(40, addOffset);
  installEscapingCallback();
  const escaped = callbacks.z_invoke_context_callback(40);
  callbacks.z_clear_context_callback();
  if (product == 42 && incremented == 42 && captured == 42 && escaped == 42) {
    return 0;
  }
  return 1;
}
