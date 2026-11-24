import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// A value-producing `async scope` inside a larger statement runs ahead of
// that statement, as a nested `await` does, and the statement reads its
// value: in `return`, an assignment, an argument, an operand, a condition.

enum Failure { broken }

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

function add(left: i32, right: i32): i32 { return left + right; }
function length(text: String): usize { return text.byteLength; }

function submit(updates: TaskScope, value: i32): boolean {
  const control: TaskControl = updates.schedule(thread.main, move (): void => {
    console.log(`operation ${value}`);
  });
  return control.accepted;
}

async function returned(): i32 {
  return async scope {
    const a = task load(1);
    const b = task load(2);
    const first = await a;
    const second = await b;
    select first + second;
  };
}

// An owned value moves out of the scope and out of the function.
async function returnedText(count: i32): String {
  return async scope {
    task note("returned text");
    const built = `built ${count}`;
    select built;
  };
}

async function returnedNamed(): boolean {
  return async scope updates {
    const first = submit(updates, 1);
    const second = submit(updates, 2);
    select first && second;
  };
}

// A failure leaves the function; the scope hands nothing over.
async function returnedFailure(): i32 throws Failure {
  return async scope {
    task slow(9);
    const result = try await fails();
    select result;
  };
}

// The scope reads the old value; the assignment replaces it afterwards.
async function assigned(): String {
  let label = "before";
  label = async scope {
    task note("assigned");
    select `after ${label.byteLength}`;
  };
  return label;
}

// Scopes in one statement run in order, each joined before the next starts.
async function arguments(): i32 {
  const sum = add(
    async scope { const a = task load(3); select await a; },
    async scope { const b = task load(4); select await b; }
  );
  const size = length(async scope { task note("argument"); select "four"; });
  console.log(`size ${size}`);
  return sum;
}

async function operands(): i32 {
  let total = 0;
  let round = 0;
  while (round < 2) {
    const doubled = 2 * async scope { task note(`round ${round}`); select round + 1; };
    total = total + doubled;
    round = round + 1;
  }
  console.log(`interpolated ${async scope { task note("template"); select 9; }}`);
  return total;
}

async function condition(): boolean {
  if (async scope { const a = task load(5); select (await a) > 3; }) {
    return true;
  }
  return false;
}

// A scope's value may be another scope's `select`.
async function selected(): i32 {
  const outer = async scope {
    task note("outer");
    select async scope {
      const inner = task load(6);
      select await inner;
    };
  };
  return outer;
}

async function main(): i32 {
  console.log(`returned ${await returned()}`);
  const text = await returnedText(3);
  console.log(`returned text ${text}`);
  const named: boolean = await returnedNamed();
  console.log(`returned named ${named}`);
  const failed = attempt await returnedFailure();
  match (failed) {
    success(value) => console.log(`returned failure ${value}`);
    failure(_) => console.log("returned failure failed");
  }
  const label = await assigned();
  console.log(`assigned ${label}`);
  console.log(`arguments ${await arguments()}`);
  console.log(`operands ${await operands()}`);
  const big: boolean = await condition();
  console.log(`condition ${big}`);
  console.log(`selected ${await selected()}`);
  return 0;
}
