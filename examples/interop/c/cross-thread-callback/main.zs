import console from "std/console";
import native from "native-callback.h";

class CalculationInput {
  readonly label: String;
  readonly adjustment: i32;
}

function main(): i32 {
  const input = new CalculationInput({
    label: "background calculation",
    adjustment: 2,
  });

  native.z_example_start_calculation(
    40,
    move (value) => value + input.adjustment
  );

  // The ARC identity remains available on the registering thread. Z retains
  // it atomically inside the arbitrary-thread callback environment.
  console.log(`started ${input.label}`);

  const result = native.z_example_join_calculation();
  console.log(`native callback result=${result}`);
  return result - 42;
}
