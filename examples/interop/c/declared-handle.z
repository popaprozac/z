import console from "std/console";
import native from "declared-handle.h";

function consumeDeclared(value: i32): i32 {
  const handle = Option.fromNullable(native.z_declared_open(value));
  return match (handle) {
    some(value) => native.z_declared_read(value);
    none => -1;
  };
}

function borrowDeclared(value: i32): i32 {
  const handle = Option.fromNullable(native.z_declared_open(value));
  return match (in handle) {
    some(value) => native.z_declared_read(value);
    none => -1;
  };
}

function main(): i32 {
  const value = consumeDeclared(42);
  const borrowed = borrowDeclared(43);
  const missing = consumeDeclared(-1);
  console.log(`declared handle=${value}`);
  if (borrowed != 43 || missing != -1) return 1;
  if (native.z_declared_close_count() != 2) return 2;
  return value - 42;
}
