import console from "std/console";
import { delay } from "std/time";

// A `match` value anywhere an expression may be: an argument, an operand, a
// field or element, a template part, a condition, a thrown or destructured
// value. It runs where it is written: what is written before it in the
// expression runs first, and what is written after runs after. In a branch
// that may not run (an arm of `?:`, the right operand of `&&` or `||`) it
// runs only when that branch does.

enum Kind { one, two }

enum Failure { broken, worse }

struct Pair { left: i32; right: i32; }

struct Box {
  value: i32;
  function add(extra: i32): i32 { return this.value + extra; }
}

function log(label: String, value: i32): i32 {
  console.log(label);
  return value;
}

function yes(label: String, value: boolean): boolean {
  console.log(label);
  return value;
}

function text(label: String): String {
  console.log(`text ${label}`);
  return `made ${label}`;
}

function add3(first: i32, second: i32, third: i32): i32 { return first + second + third; }

function add2(first: i32, second: i32): i32 { return first + second; }

function box(value: i32): Box { return Box({ value }); }

function join(prefix: String, suffix: String): String { return `${prefix}+${suffix}`; }

function size(in value: String, extra: i32): i32 { return value.byteLength == 13 ? extra : 0 - extra; }

function find(kind: Kind): Option<String> {
  return match (kind) {
    one => Option<String>.none;
    two => Option.some(text("found"));
  };
}

async function number(value: i32): i32 {
  await delay(1);
  return value;
}

async function settle(): void {
  await delay(1);
}

// An argument written before the match runs before it; one after runs after.
function arguments(kind: Kind): i32 {
  return add3(log("a", 1), match (kind) { one => log("one", 10); two => log("two", 20); }, log("c", 3));
}

function operands(kind: Kind): i32 {
  return log("left", 1) + match (kind) {
    one => 10;
    two => {
      const base = log("arm", 20);
      select base;
    }
  } + log("right", 3);
}

// A value read before the match is the value it had then.
function mutated(kind: Kind): i32 {
  let x = 1;
  const total = x + match (kind) {
    one => 0;
    two => {
      x = 100;
      select x;
    }
  };
  return total + x;
}

function receiver(kind: Kind): i32 {
  return box(log("box", 5)).add(match (kind) { one => log("one", 1); two => log("two", 2); });
}

function nested(kind: Kind): i32 {
  return add3(log("a", 1), add2(log("b", 2), match (kind) { one => log("one", 10); two => log("two", 20); }), log("c", 3));
}

function fields(kind: Kind): i32 {
  const pair = Pair({ left: log("left", 1), right: match (kind) { one => log("one", 10); two => log("two", 20); } });
  return pair.left + pair.right;
}

function template(kind: Kind): String {
  return `${log("t1", 1)} ${match (kind) { one => log("one", 10); two => log("two", 20); }} ${log("t2", 2)}`;
}

function elements(kind: Kind): i32 {
  const values = Array<i32>(log("e1", 1), match (kind) { one => log("one", 10); two => log("two", 20); }, log("e3", 3));
  return values[0] + values[1] + values[2];
}

// An owned value computed before the match is passed on afterwards.
function owned(kind: Kind): String {
  return join(text("first"), match (kind) { one => "one"; two => text("second"); });
}

function borrowed(kind: Kind): i32 {
  const kept = text("borrowed");
  return size(kept, match (kind) { one => 1; two => 2; });
}

// Two matches in one expression, in order.
function twice(kind: Kind): i32 {
  return add2(match (kind) { one => log("first one", 1); two => log("first two", 2); },
    match (kind) { one => log("second one", 10); two => log("second two", 20); });
}

// An arm that leaves the function releases what was computed before it.
function leaves(kind: Kind): String {
  return join(text("kept"), match (kind) {
    one => "one";
    two => { return "left early"; }
  });
}

function pick(flag: boolean, value: i32): i32 { return flag ? value : 0 - value; }

function label(prefix: String, value: i32): String { return `${prefix} ${value}`; }

function name(kind: Kind): String {
  return match (kind) { one => "one"; two => "two"; };
}

// An operand that begins with a match, written before another match.
function leading(kind: Kind): i32 {
  return pick(match (kind) { one => 1; two => 2; } == 2, match (kind) { one => 10; two => 20; });
}

// A template built before the match.
function prefixed(kind: Kind): String {
  return label(`${name(kind)}!`, match (kind) { one => 1; two => 2; });
}

// As a condition, a thrown value, a loop's source, and a pattern's source.
function condition(kind: Kind): i32 {
  if (match (kind) { one => false; two => true; }) {
    return 5;
  }
  return 6;
}

function thrown(kind: Kind): i32 throws Failure {
  throw match (kind) { one => Failure.broken; two => Failure.worse; };
}

function iterated(kind: Kind): i32 {
  let total = 0;
  for (const value of match (kind) { one => Array<i32>(1); two => Array<i32>(2, 3); }) {
    total = total + value;
  }
  return total;
}

function destructured(kind: Kind): i32 {
  const { left, right } = match (kind) {
    one => Pair({ left: 1, right: 2 });
    two => Pair({ left: 3, right: 4 });
  };
  return left * 10 + right;
}

// As the payload of nested enum constructors.
function wrapped(kind: Kind): i32 {
  const boxed: Option<Option<i32>> = Option.some(Option.some(match (kind) { one => 1; two => 4; }));
  return match (boxed) {
    some(inner) => {
      const value = match (inner) { some(found) => found; none => 0; };
      select value;
    }
    none => 0;
  };
}

// An owned match value, from owned payloads.
function ownedValue(kind: Kind): String {
  return join(text("prefix"), match (find(kind)) {
    some(value) => value;
    none => text("default");
  });
}

// In an async function, with a suspension before and after.
async function suspended(kind: Kind): i32 {
  const before = await number(1);
  const total = add2(log("a", before), match (kind) { one => log("one", 10); two => log("two", 20); });
  await delay(1);
  return total;
}

// As an argument of an awaited call, and of a task.
async function awaited(kind: Kind): i32 {
  const value = await number(match (kind) { one => log("one", 10); two => log("two", 20); });
  const pending = task number(match (kind) { one => 1; two => 2; });
  const joined = await pending;
  return value + joined;
}

// In a loop body and a branch of an async function.
async function looped(kind: Kind): i32 {
  let total = 0;
  let pass = 0;
  while (pass < 2) {
    if (pass == 1) {
      total = total + add2(pass, match (kind) { one => 100; two => 200; });
    }
    await delay(1);
    total = add2(total, match (kind) { one => 1; two => 2; });
    pass = pass + 1;
  }
  return total;
}

// In an arm of `?:`: only when that arm runs.
function arm(flag: boolean, kind: Kind): i32 {
  const picked = flag ? match (kind) { one => log("one", 1); two => log("two", 2); } : log("else", 0);
  return picked;
}

function bothArms(flag: boolean, kind: Kind): i32 {
  return flag
    ? match (kind) { one => log("then one", 1); two => log("then two", 2); }
    : match (kind) { one => log("else one", 10); two => log("else two", 20); };
}

// The right operand of `&&` and `||`.
function conjunction(flag: boolean, kind: Kind): boolean {
  return yes("left", flag) && match (kind) { one => yes("one", false); two => yes("two", true); };
}

function disjunction(flag: boolean, kind: Kind): boolean {
  return yes("left", flag) || match (kind) { one => yes("one", false); two => yes("two", true); };
}

// An operand before the match, inside the branch and outside it.
function inside(flag: boolean, kind: Kind): i32 {
  return add2(log("outer", 100), flag ? add2(log("inner", 10), match (kind) { one => log("one", 1); two => log("two", 2); }) : log("else", 0));
}

// An owned value from a branch.
function ownedArm(flag: boolean, kind: Kind): String {
  const picked = flag ? match (kind) { one => text("one"); two => text("two"); } : text("else");
  return picked;
}

// The same in an async function.
async function suspendedArm(flag: boolean, kind: Kind): i32 {
  await settle();
  const picked = flag ? match (kind) { one => log("one", 1); two => log("two", 2); } : log("else", 0);
  await settle();
  return picked;
}

async function main(): i32 {
  console.log(`arguments ${arguments(Kind.two)}`);
  console.log(`operands ${operands(Kind.two)}`);
  console.log(`mutated ${mutated(Kind.two)} ${mutated(Kind.one)}`);
  console.log(`receiver ${receiver(Kind.two)}`);
  console.log(`nested ${nested(Kind.one)}`);
  console.log(`fields ${fields(Kind.two)}`);
  const templated = template(Kind.one);
  console.log(`template ${templated}`);
  console.log(`elements ${elements(Kind.two)}`);
  const ownedText = owned(Kind.two);
  console.log(`owned ${ownedText}`);
  console.log(`borrowed ${borrowed(Kind.two)}`);
  console.log(`twice ${twice(Kind.two)}`);
  const stayed = leaves(Kind.one);
  const left = leaves(Kind.two);
  console.log(`leaves ${stayed} | ${left}`);
  console.log(`leading ${leading(Kind.two)} ${leading(Kind.one)}`);
  const prefixedText = prefixed(Kind.two);
  console.log(`prefixed ${prefixedText}`);
  console.log(`condition ${condition(Kind.two)} ${condition(Kind.one)}`);
  const failure = attempt thrown(Kind.two);
  match (failure) {
    success(value) => console.log(`thrown ${value}`);
    failure(error) => match (error) {
      broken => console.log("thrown broken");
      worse => console.log("thrown worse");
    }
  }
  console.log(`iterated ${iterated(Kind.two)} ${iterated(Kind.one)}`);
  console.log(`destructured ${destructured(Kind.two)} ${destructured(Kind.one)}`);
  console.log(`wrapped ${wrapped(Kind.two)} ${wrapped(Kind.one)}`);
  const ownedFirst = ownedValue(Kind.two);
  const ownedSecond = ownedValue(Kind.one);
  console.log(`ownedValue ${ownedFirst} | ${ownedSecond}`);
  console.log(`suspended ${await suspended(Kind.two)}`);
  console.log(`awaited ${await awaited(Kind.two)}`);
  console.log(`looped ${await looped(Kind.two)}`);
  console.log(`arm ${arm(true, Kind.two)} ${arm(false, Kind.two)}`);
  console.log(`bothArms ${bothArms(true, Kind.one)} ${bothArms(false, Kind.two)}`);
  console.log(`conjunction ${conjunction(true, Kind.two)} ${conjunction(false, Kind.two)}`);
  console.log(`disjunction ${disjunction(true, Kind.one)} ${disjunction(false, Kind.one)}`);
  console.log(`inside ${inside(true, Kind.two)} ${inside(false, Kind.two)}`);
  const armFirst = ownedArm(true, Kind.one);
  const armSecond = ownedArm(false, Kind.one);
  console.log(`ownedArm ${armFirst} | ${armSecond}`);
  console.log(`suspendedArm ${await suspendedArm(true, Kind.two)} ${await suspendedArm(false, Kind.two)}`);
  return 0;
}
