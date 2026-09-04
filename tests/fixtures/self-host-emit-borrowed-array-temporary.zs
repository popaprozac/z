function sum(in values: Array<i32>): i32 {
  return values[0] + values[1];
}

function main(): i32 {
  return sum(Array<i32>(20, 22)) - 42;
}
