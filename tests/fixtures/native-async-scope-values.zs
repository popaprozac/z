import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// `async scope` as a value: `const x = async scope { ... select value; };`.
// The value is the `select` that leaves the scope, handed over once every
// child the scope started has joined. A `select` may sit in a branch; it
// leaves the scope from there. `return` still leaves the function, and a
// failure still cancels the scope's children.

enum Failure { broken }

enum Kind { one, two }

async function load(value: i32): i32 {
  await delay(1);
  console.log(`loaded ${value}`);
  return value;
}

async function note(label: String): void {
  await delay(1);
  console.log(`noted ${label}`);
}

async function fails(): i32 throws Failure {
  await delay(1);
  throw Failure.broken;
}

async function slow(value: i32): i32 {
  console.log(`slow ${value} started`);
  await delay(5000);
  console.log(`slow ${value} finished`);
  return value;
}

function submit(updates: TaskScope, value: i32): boolean {
  const control: TaskControl = updates.schedule(thread.main, move (): void => {
    console.log(`operation ${value}`);
  });
  return control.accepted;
}

async function sum(): i32 {
  const total = async scope {
    const a = task load(1);
    const b = task load(2);
    const first = await a;
    const second = await b;
    select first + second;
  };
  console.log(`sum after scope ${total}`);
  return total;
}

// A `select` in a branch leaves the scope; the child it did not await is
// joined before the value is used.
async function branches(early: boolean): i32 {
  const value = async scope {
    task note(early ? "early" : "late");
    if (early) {
      select 10;
    }
    const loaded = await load(20);
    select loaded;
  };
  console.log(`branches after scope ${value}`);
  return value;
}

// An owned value: a local of the scope moves out through `select`.
async function text(count: i32): String {
  const label: String = async scope {
    task note("text");
    const built = `built ${count}`;
    select built;
  };
  return label;
}

// The handle of a named scope is visible inside the block only; its
// operations are joined before the value is handed over.
async function named(): i32 {
  const accepted = async scope updates {
    const first = submit(updates, 1);
    const second = submit(updates, 2);
    select first && second ? 2 : 0;
  };
  console.log(`named after scope ${accepted}`);
  return accepted;
}

// `return` leaves the function, after the scope's children have joined.
async function returns(early: boolean): i32 {
  const value = async scope {
    task note("returns");
    if (early) return -1;
    select 7;
  };
  return value + 1;
}

// A failure leaves the scope as it does a statement scope: the child still
// running is cancelled, and the function fails.
async function failing(): i32 throws Failure {
  const value = async scope {
    task slow(9);
    const result = try await fails();
    select result;
  };
  return value;
}

// One scope per iteration: each joins its own children.
async function loops(): i32 {
  let total = 0;
  let round = 0;
  while (round < 3) {
    const step = async scope {
      task note(`round ${round}`);
      if (round == 1) {
        select 100;
      }
      select round;
    };
    total = total + step;
    round = round + 1;
  }
  return total;
}

// The selected expression may await, and a scope may sit inside a scope.
async function nested(): i32 {
  let outer = async scope {
    const pending = task load(3);
    async scope {
      task note("inner");
    }
    select await pending;
  };
  outer = outer + 1;
  return outer;
}

// A scope's value may come from another scope's value.
async function layered(): i32 {
  const outer = async scope {
    const inner = async scope {
      const pending = task load(4);
      select await pending;
    };
    task note("layered");
    select inner + 1;
  };
  return outer;
}

// A `select` inside a statement scope leaves that scope first, then the
// value-producing one: both join before the value is used.
async function through(early: boolean): i32 {
  const value = async scope {
    async scope {
      task note(early ? "through early" : "through late");
      if (early) {
        select 30;
      }
    }
    select 40;
  };
  console.log(`through after scope ${value}`);
  return value;
}

// A `select` in a `match` arm gives that arm's value, not the scope's.
async function matched(kind: Kind): i32 {
  const value = async scope {
    task note("matched");
    const picked = match (kind) {
      one => 1;
      two => { select 2; }
    };
    select picked;
  };
  return value;
}

async function main(): i32 {
  const total = await sum();
  console.log(`sum ${total}`);
  const early = await branches(true);
  const late = await branches(false);
  console.log(`branches ${early} ${late}`);
  const label = await text(4);
  console.log(`text ${label}`);
  const accepted = await named();
  console.log(`named ${accepted}`);
  const returnedEarly = await returns(true);
  const returnedLate = await returns(false);
  console.log(`returns ${returnedEarly} ${returnedLate}`);
  const failed = attempt await failing();
  match (failed) {
    success(value) => console.log(`failing returned ${value}`);
    failure(_) => console.log("failing failed");
  }
  const looped = await loops();
  console.log(`loops ${looped}`);
  const inner = await nested();
  console.log(`nested ${inner}`);
  const layers = await layered();
  console.log(`layered ${layers}`);
  const throughEarly = await through(true);
  const throughLate = await through(false);
  console.log(`through ${throughEarly} ${throughLate}`);
  const picked = await matched(Kind.two);
  console.log(`matched ${picked}`);
  return 0;
}
