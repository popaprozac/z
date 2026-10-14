import console from "std/console";

// `Array<T>.withCapacity` as a struct literal's field, where the call has no
// recorded type of its own, and beside it as an argument and a local.
struct Builder {
  bytes: Array<u8>;
  units: Array<u16>;
}

function builder(capacity: usize): Builder {
  return Builder({ bytes: Array<u8>.withCapacity(capacity), units: Array<u16>() });
}

function reserved(values: Array<u32>): usize {
  return values.capacity;
}

function main(): i32 {
  let built = builder(8);
  built.bytes.push(1);
  const spare = Array<u32>.withCapacity(4);
  console.log(built.bytes.capacity >= 8, built.bytes.length, reserved(Array<u32>.withCapacity(16)) >= 16, spare.capacity >= 4);
  return 0;
}
