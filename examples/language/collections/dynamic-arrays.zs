import stdio from "stdio.h";

function append<T>(inout values: Array<T>, value: T): void {
  values.push(value);
}

function main(): i32 {
  let values = Array<i32>();
  values.push(10);
  append(inout values, 20);
  values.push(30);
  values[1] = 42;
  stdio.printf("length=%zu capacity=%zu middle=%d\n", values.length, values.capacity, values[1]);
  return 0;
}
