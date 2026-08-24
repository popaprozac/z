import { loadValue } from "./operations.zs";

async function main(): i32 {
  const observed = await loadValue(40);
  return observed - 42;
}
