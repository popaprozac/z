import console from "std/console";
import { delay } from "std/time";

// A block-bodied async closure is a value that may be called again and
// again. Each call runs the block as a frame of its own; the closure's
// captures stay in its environment, so an assignment to a captured `let` is
// seen by the next call.

enum Failure {
  broken,
  tooLarge i32,
}

type Counter = async (step: i32) => i32;
type Doubler = async (value: i32) => i32;
type Reporter = async () => void;
type Risky = async (value: i32) => i32 throws Failure;

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

// A closure may throw: its caller receives the typed error, and state the
// closure changed before throwing is kept.
function makeRisky(limit: i32): Risky {
  let calls = 0;
  return async move (value: i32): i32 throws Failure => {
    await delay(1);
    calls = calls + 1;
    if (value < 0) throw Failure.broken;
    if (value > limit) throw Failure.tooLarge(calls);
    return value + calls;
  };
}

async function check(value: i32): i32 throws Failure {
  await delay(1);
  if (value == 13) throw Failure.broken;
  return value;
}

// An error the block propagates with `try` leaves through the closure.
function makeChecked(): Risky {
  return async (value: i32): i32 throws Failure => {
    const checked = try await check(value);
    return checked * 2;
  };
}

function report(in outcome: Result<i32, Failure>): void {
  match (in outcome) {
    success(value) => console.log(`ok ${value}`);
    failure(error) => {
      match (in error) {
        broken => console.log("broken");
        tooLarge(calls) => console.log(`too large on call ${calls}`);
      }
    }
  }
}

// A closure written in a method lifts the same way, as long as the block
// itself does not use `this`.
class Factory {
  base: i32;

  function counter(extra: i32): Counter {
    let total = this.base + extra;
    return async move (step: i32): i32 => {
      await delay(1);
      total = total + step;
      console.log(`method total ${total}`);
      return total;
    };
  }

  static function doubler(): Doubler {
    return async (value: i32): i32 => {
      await delay(1);
      return value * 2;
    };
  }
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
  const risky = makeRisky(10);
  const accepted = attempt await risky(5);
  report(in accepted);
  const negative = attempt await risky(-1);
  report(in negative);
  const oversized = attempt await risky(50);
  report(in oversized);
  const checked = makeChecked();
  const passed = attempt await checked(4);
  report(in passed);
  const refused = attempt await checked(13);
  report(in refused);
  const factory = new Factory({ base: 10 });
  const methodCounter = factory.counter(5);
  const methodFirst = await methodCounter(1);
  const methodSecond = await methodCounter(2);
  console.log(`method counted ${methodFirst} ${methodSecond}`);
  const methodDoubler = Factory.doubler();
  const methodDoubled = await methodDoubler(21);
  console.log(`method doubled ${methodDoubled}`);
  return 0;
}
