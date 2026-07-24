import callbacks from "callbacks-any-thread.h";

class CalculationInput {
  readonly label: String;
  readonly offset: i32;
}

function main(): i32 {
  const input = new CalculationInput({
    label: "native callback",
    offset: 2,
  });

  callbacks.z_start_any_thread_callback(
    40,
    move (value) => value + input.offset
  );
  const result = callbacks.z_join_any_thread_callback();

  if (input.label == "native callback" && result == 42) {
    return 0;
  }
  return 1;
}
