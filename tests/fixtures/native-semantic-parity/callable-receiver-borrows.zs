import console from "std/console";
struct Counter {
  value: i32;
  function apply(inout this, handler: (inout counter: Counter, delta: i32) => i32): i32 {
    return handler(inout this, 2);
  }
  function inspect(handler: (in counter: Counter) => i32): i32 {
    return handler(in this);
  }
}
function add(inout counter: Counter, delta: i32): i32 { counter.value = counter.value + delta; return counter.value; }
function read(in counter: Counter): i32 { return counter.value; }
function main(): i32 {
  let counter = Counter({ value: 1 });
  const handler: (inout counter: Counter, delta: i32) => i32 = add;
  const reader: (in counter: Counter) => i32 = read;
  if (counter.apply(handler) != 3) return 1;
  if (counter.inspect(reader) != 3) return 2;
  if (counter.apply(add) != 5) return 3;
  console.log("ok");
  return 0;
}
