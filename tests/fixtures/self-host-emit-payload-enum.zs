enum Reading {
  count i32,
  idle,
}

function makeCount(value: i32): Reading {
  return Reading.count(value);
}

function makeIdle(): Reading {
  return Reading.idle;
}

function main(): i32 {
  makeCount(42);
  makeIdle();
  return 42;
}
