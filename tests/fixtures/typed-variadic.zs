import native from "./typed-variadic.h";

function configure(): void throws native.ZTypedOption {
  try native.z_typed_setopt(native.Z_TYPED_TEXT, "typed");
  try native.z_typed_setopt(native.Z_TYPED_TIMEOUT, 10);
}

function main(): i32 {
  return match (attempt configure()) {
    success => native.z_typed_length() - 5;
    failure(error) => 1;
  };
}
