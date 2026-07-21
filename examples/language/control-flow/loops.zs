import stdio from "stdio.h";

struct Iteration {
  value: i32;

  deinit {
    stdio.printf("drop=%d\n", this.value);
  }
}

function main(): i32 {
  let index = 0;
  let total = 0;

  while (index < 6) {
    index = index + 1;
    const iteration = Iteration({ value: index });

    if (index == 2) {
      continue;
    }

    total = total + index;
    if (index == 4) {
      break;
    }
  }

  stdio.printf("total=%d\n", total);
  return 0;
}
