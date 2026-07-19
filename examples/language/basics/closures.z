import stdio from "stdio.h";

function main(): i32 {
  const offset = 2;
  const add = (value: i32): i32 => value + offset;

  let total = 0;
  const accumulate = (value: i32): i32 => {
    total = total + value;
    return total;
  };

  let seed = 10;
  const snapshot = move (value: i32): i32 => seed + value;
  seed = 100;

  let target = 40;
  const increment = (inout value: i32): void => {
    value = value + 2;
    return;
  };
  increment(inout target);

  const first = accumulate(20);
  const second = accumulate(22);

  stdio.printf("add=%d\n", add(40));
  stdio.printf("total=%d,%d\n", first, second);
  stdio.printf("snapshot=%d seed=%d\n", snapshot(5), seed);
  stdio.printf("target=%d\n", target);
  return 0;
}
