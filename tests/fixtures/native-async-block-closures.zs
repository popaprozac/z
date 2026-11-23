import console from "std/console";
import { delay } from "std/time";

// A block-bodied async closure is a value that may be called again and
// again. Each call runs the block as a frame of its own; the closure's
// captures stay in its environment, so an assignment to a captured `let` is
// seen by the next call.

type Counter = async (step: i32) => i32;
type Doubler = async (value: i32) => i32;
type Reporter = async () => void;

function makeCounter(base: i32): Counter {
  let total = base;
  return async move (step: i32): i32 => {
    await delay(1);
    total = total + step;
    console.log(`total ${total}`);
    return total;
  };
}

// No captures: the block keeps locals across suspensions in a loop.
function makeDoubler(): Doubler {
  return async (value: i32): i32 => {
    let doubled = 0;
    let round = 0;
    while (round < 2) {
      await delay(1);
      doubled = doubled + value;
      round = round + 1;
    }
    return doubled;
  };
}

async function triple(value: i32): i32 {
  await delay(1);
  return value * 3;
}

function makeReporter(base: i32): Reporter {
  return async move (): void => {
    const tripled = await triple(base);
    if (tripled > 10) {
      console.log(`large ${tripled}`);
      return;
    }
    console.log(`small ${tripled}`);
  };
}

async function relay(operation: Counter, step: i32): i32 {
  return await operation(step);
}

async function main(): i32 {
  const counter = makeCounter(10);
  const first = await counter(2);
  const second = await counter(3);
  console.log(`counted ${first} ${second}`);
  const doubler = makeDoubler();
  const doubled = await doubler(21);
  console.log(`doubled ${doubled}`);
  const small = makeReporter(2);
  await small();
  const large = makeReporter(5);
  await large();
  const relayed = await relay(makeCounter(100), 5);
  console.log(`relayed ${relayed}`);
  return 0;
}
