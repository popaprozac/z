import { Calculator, double as scale } from "./library.zs";

async function main(): i32 {
  const calculator = new Calculator({});
  // The parameter alias is private to the library. No local annotation is
  // necessary to pass an imported named function as a first-class callback.
  const direct = calculator.apply(scale, 21);
  const offset = 2;
  const closure = move (value: i32): i32 => value + offset;
  const captured = calculator.apply(closure, 40);
  return direct + captured - 84;
}
