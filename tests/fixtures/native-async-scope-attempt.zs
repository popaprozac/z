import console from "std/console";
import { TaskControl, TaskScope } from "std/async";
import { thread } from "std/thread";
import { delay } from "std/time";

// `attempt async scope { ... }`: the scope is an error boundary. A `try` or
// `throw` inside fails the scope, not the function: the scope's children are
// cancelled and joined, and the expression gives `failure(error)`. A `select`
// gives `success(value)`; with no `select` the scope succeeds by reaching its
// end. The error type is the annotation's, or the first `try` or `throw`
// decides it. `return` still leaves the function.

enum Failure { broken }

enum Other { odd }

struct Problem { reason: String; code: i32; }

async function load(value: i32): i32 {
  await delay(1);
  return value;
}

async function note(label: String): void {
  await delay(1);
  console.log(`noted ${label}`);
}

async function checked(value: i32, fail: boolean): i32 throws Failure {
  await delay(1);
  if (fail) throw Failure.broken;
  return value;
}

async function odd(fail: boolean): i32 throws Other {
  await delay(1);
  if (fail) throw Other.odd;
  return 9;
}

async function described(fail: boolean): String throws Problem {
  await delay(1);
  if (fail) throw Problem({ reason: "described failed", code: 7 });
  return "described";
}

function risky(value: i32, fail: boolean): i32 throws Failure {
  if (fail) throw Failure.broken;
  return value;
}

function describe(outcome: Result<i32, Failure>): String {
  return match (outcome) {
    success(value) => `success ${value}`;
    failure(_) => "failure";
  };
}

function submit(updates: TaskScope, value: i32): boolean {
  const control: TaskControl = updates.schedule(thread.main, move (): void => {
    console.log(`operation ${value}`);
  });
  return control.accepted;
}

// Finishes at once when the scope succeeds; outlives it when it fails.
async function lingering(id: i32, long: boolean): i32 {
  console.log(`lingering ${id} started`);
  if (long) {
    await delay(5000);
  } else {
    await delay(1);
  }
  console.log(`lingering ${id} finished`);
  return id;
}

// A `try` that fails gives `failure`; the children are cancelled and joined.
async function values(fail: boolean): i32 {
  const outcome = attempt async scope {
    const pending = task load(1);
    task lingering(1, fail);
    const checkedValue = try await checked(2, fail);
    const loaded = await pending;
    select loaded + checkedValue;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -1;
  };
}

// No `select`: the scope succeeds by reaching its end.
async function work(fail: boolean): String {
  const outcome = attempt async scope {
    task note(fail ? "work failing" : "work passing");
    try await checked(1, fail);
  };
  return match (outcome) {
    success => "done";
    failure(_) => "failed";
  };
}

// `throw` fails the scope too.
async function thrown(fail: boolean): i32 {
  const outcome = attempt async scope {
    task note("thrown");
    if (fail) throw Failure.broken;
    select 5;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -5;
  };
}

// Owned success and error values.
async function owned(fail: boolean): String {
  const outcome = attempt async scope {
    task note("owned");
    const text = try await described(fail);
    select `${text} value`;
  };
  return match (outcome) {
    success(text) => text;
    failure(problem) => `${problem.reason} ${problem.code}`;
  };
}

// The annotation gives both types.
async function annotated(fail: boolean): i32 {
  const outcome: Result<i32, Failure> = attempt async scope {
    const value = try risky(3, fail);
    select value;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -3;
  };
}

// A failure inside a nested scope leaves both.
async function nested(fail: boolean): i32 {
  const outcome = attempt async scope {
    task note("outer");
    async scope {
      task note("inner");
      task lingering(2, fail);
      try await checked(1, fail);
    }
    const inner = async scope {
      const pending = task load(4);
      select await pending;
    };
    select inner;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -4;
  };
}

// One attempt per pass of a loop.
async function loops(): i32 {
  let total = 0;
  let pass = 0;
  while (pass < 3) {
    const outcome = attempt async scope {
      task note(`pass ${pass}`);
      const value = try await checked(pass, pass == 1);
      select value + 10;
    };
    match (outcome) {
      success(value) => total = total + value;
      failure(_) => total = total + 100;
    }
    pass = pass + 1;
  }
  return total;
}

// As an argument and as a returned value: the scope runs ahead of the statement.
async function argument(fail: boolean): String {
  return describe(attempt async scope {
    task note("argument");
    const value = try await checked(1, fail);
    select value;
  });
}

async function returned(fail: boolean): Result<i32, Failure> {
  return attempt async scope {
    task note("returned");
    const value = try await checked(2, fail);
    select value;
  };
}

// `return` inside the scope still leaves the function.
async function leaves(early: boolean, fail: boolean): i32 {
  const outcome = attempt async scope {
    task note("leaves");
    if (early) return 40;
    const value = try await checked(3, fail);
    select value;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -3;
  };
}

// In a throwing function: a `try` outside the scope fails the function, one
// inside fails the scope. The two error types are independent.
async function mixed(inner: boolean, outer: boolean): i32 throws Other {
  const outcome = attempt async scope {
    task note("mixed");
    const value = try await checked(4, inner);
    select value;
  };
  const extra = try await odd(outer);
  return match (outcome) {
    success(value) => value + extra;
    failure(_) => -extra;
  };
}

// Several tries: the first to fail decides.
async function several(first: boolean, second: boolean): i32 {
  const outcome = attempt async scope {
    task note("several");
    const left = try await checked(5, first);
    const right = try await checked(6, second);
    select left + right;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -5;
  };
}

// An attempted scope inside an attempted scope: each catches its own.
async function layered(inner: boolean, outer: boolean): i32 {
  const outcome = attempt async scope {
    task note("layered outer");
    const innerOutcome = attempt async scope {
      task note("layered inner");
      const value = try await checked(7, inner);
      select value;
    };
    const recovered = match (innerOutcome) {
      success(value) => value;
      failure(_) => 70;
    };
    const more = try await checked(1, outer);
    select recovered + more;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -7;
  };
}

// A named scope: its handle's operations are joined before the outcome.
async function named(fail: boolean): i32 {
  const outcome = attempt async scope updates {
    const accepted = submit(updates, 1);
    const value = try await checked(2, fail);
    select accepted ? value : 0;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -2;
  };
}

async function steady(id: i32): i32 {
  console.log(`steady ${id} started`);
  await delay(20);
  console.log(`steady ${id} finished`);
  return id;
}

// What a scope declared is released whether it succeeds or fails, one pass
// after another, with no child to join.
async function releases(): i32 {
  let total = 0;
  let pass = 0;
  while (pass < 3) {
    const outcome = attempt async scope {
      const label = `label ${pass}`;
      const value = try await checked(pass, pass == 1);
      const after = `after ${pass}`;
      console.log(`${label} ${after}`);
      select value;
    };
    match (outcome) {
      success(value) => total = total + value;
      failure(_) => total = total + 100;
    }
    pass = pass + 1;
  }
  return total;
}

// A child started outside the scope is not the scope's to cancel.
async function outside(): i32 {
  const outer = task steady(1);
  const outcome = attempt async scope {
    task steady(2);
    const value = try await checked(1, true);
    select value;
  };
  const kept = await outer;
  return match (outcome) {
    success(value) => value + kept;
    failure(_) => kept * 10;
  };
}

// Cancelled while waiting inside an attempted scope: the function unwinds.
async function waits(): i32 {
  const outcome = attempt async scope {
    const label = "waiting";
    console.log(label);
    await delay(5000);
    const value = try await checked(1, false);
    select value;
  };
  return match (outcome) {
    success(value) => value;
    failure(_) => -1;
  };
}

async function main(): i32 {
  console.log(`values ${await values(false)} ${await values(true)}`);
  const passed = await work(false);
  const failed = await work(true);
  console.log(`work ${passed} ${failed}`);
  console.log(`thrown ${await thrown(false)} ${await thrown(true)}`);
  const ownedPassed = await owned(false);
  const ownedFailed = await owned(true);
  console.log(`owned ${ownedPassed} | ${ownedFailed}`);
  console.log(`annotated ${await annotated(false)} ${await annotated(true)}`);
  console.log(`nested ${await nested(false)} ${await nested(true)}`);
  console.log(`loops ${await loops()}`);
  const argumentPassed = await argument(false);
  const argumentFailed = await argument(true);
  console.log(`argument ${argumentPassed} | ${argumentFailed}`);
  const returnedFirst = await returned(false);
  const returnedSecond = await returned(true);
  const returnedPassed = describe(returnedFirst);
  const returnedFailed = describe(returnedSecond);
  console.log(`returned ${returnedPassed} | ${returnedFailed}`);
  console.log(`leaves ${await leaves(true, false)} ${await leaves(false, false)} ${await leaves(false, true)}`);
  const both = attempt await mixed(false, false);
  const innerOnly = attempt await mixed(true, false);
  const outerOnly = attempt await mixed(false, true);
  const mixedBoth = match (both) { success(value) => value; failure(_) => -99; };
  const mixedInner = match (innerOnly) { success(value) => value; failure(_) => -99; };
  const mixedOuter = match (outerOnly) { success(value) => value; failure(_) => -99; };
  console.log(`mixed ${mixedBoth} ${mixedInner} ${mixedOuter}`);
  console.log(`several ${await several(false, false)} ${await several(true, false)} ${await several(false, true)}`);
  console.log(`layered ${await layered(false, false)} ${await layered(true, false)} ${await layered(false, true)}`);
  console.log(`named ${await named(false)} ${await named(true)}`);
  console.log(`releases ${await releases()}`);
  console.log(`outside ${await outside()}`);
  const pending = task waits();
  await delay(5);
  await pending.cancel();
  console.log("cancelled");
  return 0;
}
