import stdio from "stdio.h";

function classify(value: i32, enabled: boolean): i32 {
  if (!enabled) {
    return 0;
  } else if (value > 10 && value != 42) {
    return 1;
  } else {
    return 2;
  }
}

function main(): i32 {
  const ready = true;
  stdio.printf("disabled=%d\n", classify(1, false));
  stdio.printf("ordinary=%d\n", classify(11, ready));
  stdio.printf("special=%d\n", classify(42, ready));
  return 0;
}
