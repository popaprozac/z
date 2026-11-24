import console from "std/console";
import { delay } from "std/time";

// A value-producing `async scope` in a branch that may not run: an arm of
// `?:`, the right operand of `&&` or `||`. The operator runs ahead of its
// statement as one unit, its condition first and then only the branch
// taken, so the scope runs exactly when its branch would.

async function load(value: i32): i32 {
  await delay(1);
  console.log(`loaded ${value}`);
  return value;
}

async function note(label: String): void {
  await delay(1);
  console.log(`noted ${label}`);
}

async function check(label: String, result: boolean): boolean {
  await delay(1);
  console.log(`checked ${label}`);
  return result;
}

function id(value: i32): i32 { return value; }

async function oneArm(flag: boolean): i32 {
  const value = flag ? async scope { const a = task load(1); select await a; } : id(0);
  return value;
}

async function bothArms(flag: boolean): i32 {
  return flag
    ? async scope { task note("then"); select 10; }
    : async scope { task note("else"); select 20; };
}

// An owned value comes out of the taken arm.
async function ownedArm(flag: boolean): String {
  const label = flag ? async scope { task note("owned"); select `built ${1}`; } : "plain";
  return label;
}

async function nestedArms(outer: boolean, inner: boolean): i32 {
  return outer
    ? (inner ? async scope { task note("inner"); select 1; } : 2)
    : async scope { task note("outer"); select 3; };
}

// The scope may decide the condition instead: it then runs every time.
async function asCondition(): i32 {
  return async scope { const b = task load(7); select (await b) > 3; } ? 1 : 2;
}

async function conjunction(first: boolean, second: boolean): boolean {
  return first && async scope { const right = task check("and", second); select await right; };
}

async function disjunction(first: boolean, second: boolean): boolean {
  const result = first || async scope { const right = task check("or", second); select await right; };
  return result;
}

// Each `&&` stops the chain as soon as one scope says no.
async function chain(first: boolean): boolean {
  return first
    && async scope { const one = task check("one", true); select await one; }
    && async scope { const two = task check("two", false); select await two; }
    && async scope { const three = task check("three", true); select await three; };
}

async function main(): i32 {
  console.log(`one arm ${await oneArm(true)} ${await oneArm(false)}`);
  console.log(`both arms ${await bothArms(true)} ${await bothArms(false)}`);
  const owned = await ownedArm(true);
  const plain = await ownedArm(false);
  console.log(`owned arm ${owned} ${plain}`);
  console.log(`nested arms ${await nestedArms(true, true)} ${await nestedArms(true, false)} ${await nestedArms(false, true)}`);
  console.log(`as condition ${await asCondition()}`);
  let round = 0;
  while (round < 2) {
    console.log(`argument ${id(round == 0 ? async scope { task note("zero"); select 100; } : round)}`);
    round = round + 1;
  }
  const andTrue: boolean = await conjunction(true, true);
  const andFalse: boolean = await conjunction(true, false);
  const andSkipped: boolean = await conjunction(false, true);
  console.log(`and ${andTrue} ${andFalse} ${andSkipped}`);
  const orSkipped: boolean = await disjunction(true, false);
  const orTrue: boolean = await disjunction(false, true);
  const orFalse: boolean = await disjunction(false, false);
  console.log(`or ${orSkipped} ${orTrue} ${orFalse}`);
  const chained: boolean = await chain(true);
  const unchained: boolean = await chain(false);
  console.log(`chain ${chained} ${unchained}`);
  const ready = true;
  if (ready && async scope { const guard = task check("if", true); select await guard; }) {
    console.log("entered");
  }
  return 0;
}
