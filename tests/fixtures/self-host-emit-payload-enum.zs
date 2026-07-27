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

function read(reading: Reading): i32 {
  match (reading) {
    count(value) => return value;
    idle => return 0;
  }
}

function main(): i32 {
  const reading: Reading = makeCount(42);
  makeIdle();
  return read(reading);
}
