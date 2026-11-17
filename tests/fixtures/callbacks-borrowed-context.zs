import callbacks from "callbacks.h";
import stdio from "stdio.h";

struct Counter {
  total: i32;
  calls: i32;

  function add(inout this, amount: i32): i32 {
    this.total = this.total + amount;
    this.calls = this.calls + 1;
    return this.total;
  }
}

// The closure captures the caller's `inout` parameter. C is lent that
// borrow for the call and comes back through it.
function addThroughC(inout counter: Counter, amount: i32): i32 {
  return callbacks.z_apply_context_i32(amount, (value) => counter.add(value));
}

// C calls the callback twice, and each call goes back into C through the
// same borrow, to `depth` levels.
function nested(inout counter: Counter, depth: i32): i32 {
  return callbacks.z_apply_context_twice_i32(0, (value) => {
    if (depth > 0) return nested(inout counter, depth - 1) + value;
    return counter.add(1) + value;
  });
}

function main(): i32 {
  let counter = Counter({ total: 0, calls: 0 });
  const first = addThroughC(inout counter, 5);
  let local = 10;
  const second = callbacks.z_apply_context_i32(7, (value) => {
    local = local + value;
    return local;
  });
  const third = nested(inout counter, 2);
  stdio.printf("borrowed-context=%d,%d,%d total=%d calls=%d local=%d\n", first, second, third, counter.total, counter.calls, local);
  return 0;
}
