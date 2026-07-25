import native from "./nested-native/anonymous-status.h";

function main(): i32 {
  const started = attempt native.z_anonymous_start();
  return match (started) {
    success => 0;
    failure(error) => error == native.Z_ANONYMOUS_FAILED ? 4 : 1;
  };
}
