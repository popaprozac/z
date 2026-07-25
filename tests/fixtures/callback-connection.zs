import native from "callback-connection.h";

function run(): void throws native.ZCallbackStatus {
  const owner = native.z_callback_open();
  if (owner == null) throw native.Z_CALLBACK_FAILED;

  const writer = try native.z_callback_setopt(
    owner,
    native.Z_CALLBACK_WRITE,
    move (bytes: Slice<u8>): usize => {
      return bytes.length;
    }
  );
  try native.z_callback_perform(owner);
}

function main(): i32 {
  const result = attempt run();
  return match (result) {
    success => 0;
    failure(_) => 1;
  };
}
