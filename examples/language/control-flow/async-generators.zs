import console from "std/console";
import { AsyncGenerator } from "std/iteration";
import { delay } from "std/time";

async function values(): AsyncGenerator<i32, i32> {
  yield 20;
  await delay(1);
  yield 22;
  return 42;
}

async function main(): i32 {
  const sequence = values();

  const first = await sequence.next();
  const firstValue = match (first) {
    yielded(value) => value;
    complete(value) => 0;
  };

  const second = await sequence.next();
  const secondValue = match (second) {
    yielded(value) => value;
    complete(value) => 0;
  };

  const terminal = await sequence.next();
  const total = match (terminal) {
    yielded(value) => 0;
    complete(value) => value;
  };

  console.log(`async generator ${firstValue} ${secondValue} complete=${total}`);
  return firstValue + secondValue + total - 84;
}
