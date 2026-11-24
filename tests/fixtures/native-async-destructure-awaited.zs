import console from "std/console";
import { delay } from "std/time";

// Object destructuring whose source suspends: an awaited call, an awaited
// task, `try await`, and a value-producing `async scope`. The whole value
// moves into the pattern's hidden owner; the selected fields move out of it
// and the rest is released at once. A pattern may sit at the function root
// or inside a branch or loop.

enum Failure { broken }

struct Pair { left: i32; right: i32; }

struct Named { name: String; count: i32; }

struct Held { id: i32; label: String; spare: String; }

class Receipt {
  label: String;

  deinit {
    console.log(`released ${this.label}`);
  }
}

struct Delivery { receipt: Receipt; title: String; }

async function deliver(round: i32): Delivery {
  await delay(1);
  return Delivery({ receipt: new Receipt({ label: `receipt ${round}` }), title: `title ${round}` });
}

async function pair(base: i32): Pair {
  await delay(1);
  return Pair({ left: base, right: base + 1 });
}

async function named(count: i32): Named {
  await delay(1);
  return Named({ name: `name ${count}`, count });
}

async function held(id: i32): Held {
  await delay(1);
  return Held({ id, label: `label ${id}`, spare: `spare ${id}` });
}

async function checked(count: i32, fail: boolean): Named throws Failure {
  await delay(1);
  if (fail) throw Failure.broken;
  return Named({ name: `checked ${count}`, count });
}

async function fails(): i32 throws Failure {
  await delay(1);
  throw Failure.broken;
}

function local(id: i32): Held {
  return Held({ id, label: `local ${id}`, spare: `spare ${id}` });
}

function make(count: i32, fail: boolean): Named throws Failure {
  if (fail) throw Failure.broken;
  return Named({ name: `made ${count}`, count });
}

async function plain(): i32 {
  const { left, right } = await pair(1);
  await delay(1);
  return left * 10 + right;
}

// Owned fields move out of the awaited value and survive a later suspension.
async function owned(): String {
  const { name, count } = await named(3);
  await delay(1);
  return `${name} x${count}`;
}

// A field the pattern does not select is released with the hidden owner.
async function partial(): String {
  const { label } = await held(4);
  await delay(1);
  return label;
}

async function renamed(): i32 {
  const { left: first, right: second } = await pair(5);
  await delay(1);
  return first * 10 + second;
}

async function joined(): String {
  const pending = task named(6);
  const { name } = await pending;
  return name;
}

// `try await`: a failure leaves before the pattern binds anything.
async function fallible(fail: boolean): String throws Failure {
  const { name, count } = try await checked(7, fail);
  await delay(1);
  return `${name} x${count}`;
}

// The same through a `try` that does not suspend.
function direct(fail: boolean): String throws Failure {
  const { name, count } = try make(8, fail);
  return `${name} x${count}`;
}

// A named owner is destructured with an explicit `move` or `copy`.
async function explicit(): String {
  const first = await named(9);
  const second = await named(10);
  const { name: moved } = move first;
  const { name: copied } = copy second;
  await delay(1);
  return `${moved} ${copied} ${second.name}`;
}

// From a scope's value: the scope joins its children, then the pattern binds.
async function scoped(): String {
  const { name, count } = async scope {
    const pending = task named(11);
    select await pending;
  };
  const { left, right } = async scope {
    const second = task pair(count);
    const found = await second;
    select found;
  };
  await delay(1);
  return `${name} ${left} ${right}`;
}

// In a branch, with a suspension after it inside the same block.
async function branch(take: boolean): String {
  let result = "none";
  if (take) {
    const { name, count } = await named(12);
    await delay(1);
    result = `${name} x${count}`;
  }
  await delay(1);
  return result;
}

// One per iteration: each iteration's values are released before the next,
// and when the loop is left early.
async function loop(): i32 {
  let total = 0;
  let round = 0;
  while (round < 5) {
    const { label, id } = await held(round);
    round = round + 1;
    if (id == 0) continue;
    await delay(1);
    console.log(`loop ${label}`);
    total = total + id;
    if (id == 2) break;
  }
  return total;
}

// Inside an `async scope`, what the pattern bound is released when the scope
// ends: once per pass of the loop, before the statement after the scope.
async function scopes(): void {
  let pass = 0;
  while (pass < 2) {
    async scope {
      const { receipt, title } = await deliver(pass);
      await delay(1);
      console.log(`${receipt.label} ${title}`);
    }
    console.log("scope ended");
    pass = pass + 1;
  }
}

// Returning from inside the block that holds the pattern.
async function returns(early: boolean): String {
  if (early) {
    const { label } = await held(13);
    await delay(1);
    return label;
  }
  return "late";
}

// A source that does not suspend, in a block of a function that does.
async function synchronous(): String {
  let result = "";
  if (result.byteLength == 0) {
    const { label, spare } = local(14);
    await delay(1);
    result = `${label} ${spare}`;
  }
  return result;
}

// Cancelled while suspended after the pattern bound its fields.
async function waits(nested: boolean): i32 {
  if (nested) {
    const { label, id } = await held(15);
    console.log(`waits ${label}`);
    await delay(5000);
    return id;
  }
  const { label: rootLabel, id: rootId } = await held(16);
  console.log(`waits ${rootLabel}`);
  await delay(5000);
  return rootId;
}

// A failure after the pattern releases what it bound.
async function throwing(): i32 throws Failure {
  const { label } = await held(17);
  console.log(`throwing ${label}`);
  const value = try await fails();
  return value;
}

async function main(): i32 {
  console.log(`plain ${await plain()}`);
  const ownedText = await owned();
  console.log(`owned ${ownedText}`);
  const partialText = await partial();
  console.log(`partial ${partialText}`);
  console.log(`renamed ${await renamed()}`);
  const joinedText = await joined();
  console.log(`joined ${joinedText}`);
  const passed = attempt await fallible(false);
  match (passed) {
    success(text) => console.log(`fallible ${text}`);
    failure(_) => console.log("fallible failed");
  }
  const failed = attempt await fallible(true);
  match (failed) {
    success(text) => console.log(`fallible ${text}`);
    failure(_) => console.log("fallible failed");
  }
  const made = attempt direct(false);
  match (made) {
    success(text) => console.log(`direct ${text}`);
    failure(_) => console.log("direct failed");
  }
  const unmade = attempt direct(true);
  match (unmade) {
    success(text) => console.log(`direct ${text}`);
    failure(_) => console.log("direct failed");
  }
  const explicitText = await explicit();
  console.log(`explicit ${explicitText}`);
  const scopedText = await scoped();
  console.log(`scoped ${scopedText}`);
  const taken = await branch(true);
  const skipped = await branch(false);
  console.log(`branch ${taken} ${skipped}`);
  console.log(`loop ${await loop()}`);
  await scopes();
  const early = await returns(true);
  const late = await returns(false);
  console.log(`returns ${early} ${late}`);
  const synchronousText = await synchronous();
  console.log(`synchronous ${synchronousText}`);
  const first = task waits(true);
  const second = task waits(false);
  await delay(20);
  await first.cancel();
  await second.cancel();
  console.log("cancelled");
  const thrown = attempt await throwing();
  match (thrown) {
    success(value) => console.log(`throwing ${value}`);
    failure(_) => console.log("throwing failed");
  }
  return 0;
}
