import console from "std/console";
import { thread } from "std/thread";
import { importedAdd } from "./named-callable-library.zs";

struct Counter { value: i32; }
type Handler = (inout counter: Counter, delta: i32) => i32;
type Unary = (value: i32) => i32;
type SharedUnary = (value: i32) => i32 on thread.any;
function add(inout counter: Counter, delta: i32): i32 {
  counter.value = counter.value + delta;
  return counter.value;
}
function increment(value: i32): i32 { return value + 1; }
function sharedIncrement(value: i32): i32 on thread.any { return value + 1; }
function install(handler: Handler, inout counter: Counter): i32 { return handler(inout counter, 2); }
function apply(handler: Unary, value: i32): i32 { return handler(value); }
function applyInline(handler: (value: i32) => i32): i32 { return handler(41); }
function applyShared(handler: SharedUnary): i32 { return handler(41); }
function applyBorrowed(in handler: Unary): i32 { return handler(41); }
function applyOptional(in handler: Unary, value: Option<i32>): i32 {
  return match (value) { some(number) => handler(number); none => -1; };
}
function forward(handler: Unary): i32 { return apply(handler, 41); }

class Token { deinit { console.log("released"); } }
function captureLifetime(): boolean {
  const token = new Token({});
  const handler: Unary = move (value: i32): i32 => {
    const kept = token;
    return value + 1;
  };
  if (applyBorrowed(in handler) != 42) return false;
  if (applyOptional(handler, Option.some(41)) != 42) return false;
  if (applyOptional(in handler, Option.some(41)) != 42) return false;
  return apply(handler, 41) == 42;
}

function main(): i32 {
  let counter = Counter({ value: 1 });
  if (install(add, inout counter) != 3) return 1;
  if (apply(increment, 41) != 42) return 2;
  if (applyInline(increment) != 42) return 3;
  if (applyShared(sharedIncrement) != 42) return 4;
  if (apply(importedAdd, 41) != 42) return 5;
  if (forward(increment) != 42) return 6;
  if (!captureLifetime()) return 7;
  console.log("ok");
  return 0;
}
