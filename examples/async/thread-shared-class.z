import console from "std/console";
import { thread } from "std/thread";

class CalculationInput {
  readonly label: String;
  readonly left: i32;
  readonly right: i32;
}

function makeLabel(): String {
  return `calculation`;
}

async function main(): i32 {
  const input = new CalculationInput({ label: makeLabel(), left: 20, right: 22 });
  const calculation = thread.spawn(move () => input.left + input.right);

  // Deeply readonly ARC identity is retained for the worker, so the parent
  // keeps its own reference while the native thread runs.
  console.log(`${input.label} parent input=${input.left}`);

  const answer = await calculation;
  console.log(`thread answer=${answer}`);
  return answer - 42;
}
