import console from "std/console";

struct Counter {
  value: i32;

  inline function doubled(): i32 {
    return this.value * 2;
  }

  static inline function zero(): Counter {
    return Counter({ value: 0 });
  }

  cold function report(): void {
    console.log("counter", this.value);
  }
}

inline function add(a: i32, b: i32): i32 {
  return a + b;
}

export inline function sub(a: i32, b: i32): i32 {
  return a - b;
}

cold function fail(code: i32): i32 {
  console.error("failed", code);
  return code;
}

// `inline` and `cold` stay ordinary names elsewhere.
function names(): i32 {
  const inline = 2;
  const cold = 3;
  return inline + cold;
}

function main(): i32 {
  const counter = Counter({ value: 20 });
  if (add(counter.doubled(), 2) != 42 || sub(5, 2) != 3 || Counter.zero().value != 0 || names() != 5) return fail(1);
  counter.report();
  return 0;
}
