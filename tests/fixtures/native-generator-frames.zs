import console from "std/console";
import { Generator } from "std/iteration";

struct Ticket {
  id: i32;

  deinit {
    console.log(`released ticket ${this.id}`);
  }
}

struct Window {
  low: i32;
  high: i32;
}

// Owned parameter and local: released when the body completes, or when an
// unfinished generator is dropped.
function tickets(label: String, count: i32): Generator<i32, String> {
  const holder = Ticket({ id: count });
  let index = 0;
  while (index < count) {
    yield index + holder.id * 10;
    index = index + 1;
    if (index == 5) return `stopped ${label}`;
  }
  return `done ${label}`;
}

// Yielded values are owned by the caller.
function names(count: i32): Generator<String> {
  let index = 0;
  while (index < count) {
    yield `name-${index}`;
    index = index + 1;
  }
}

// A generator that advances another generator and yields aggregates.
function windows(limit: i32): Generator<Window> {
  let source = evens(limit);
  let running = true;
  while (running) {
    const step = source.next();
    const value = match (step) {
      some(found) => found;
      none => -1;
    };
    if (value < 0) {
      running = false;
    } else {
      const window = Window({ low: value, high: value + 1 });
      yield window;
    }
  }
}

function evens(limit: i32): Generator<i32> {
  let value = 0;
  while (value < limit) {
    if (value % 2 == 0) yield value;
    value = value + 1;
  }
}

function drain(values: Generator<i32, String>): String {
  let sum = 0;
  let summary = "";
  let running = true;
  while (running) {
    const step = values.next();
    match (step) {
      yielded(value) => sum = sum + value;
      complete(text) => {
        summary = text;
        running = false;
      }
    }
  }
  console.log(`sum ${sum}`);
  return summary;
}

function main(): i32 {
  const all = drain(tickets("all", 3));
  console.log(all);
  const early = drain(tickets("early", 7));
  console.log(early);
  {
    const partial = tickets("dropped", 4);
    const first = partial.next();
    match (first) {
      yielded(value) => console.log(`first ${value}`);
      complete(_) => console.log("empty");
    }
  }
  const listed = names(2);
  const first = listed.next();
  match (first) {
    some(name) => console.log(name);
    none => console.log("none");
  }
  const second = listed.next();
  match (second) {
    some(name) => console.log(name);
    none => console.log("none");
  }
  const third = listed.next();
  match (third) {
    some(name) => console.log(name);
    none => console.log("finished");
  }
  let total = 0;
  for (const window of windows(6)) {
    total = total + window.low * 10 + window.high;
  }
  console.log(`windows ${total}`);
  return 0;
}
