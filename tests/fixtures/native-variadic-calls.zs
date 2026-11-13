import stdio from "stdio.h";

function main(): i32 {
  const count: i32 = 3;
  const ratio: f64 = 1.5;
  const half: f32 = 0.5;
  const ready = true;
  const name = "zed";
  let values: i32[4] = [10, 20, 30, 40];
  const length = values.length;
  stdio.printf("plain\n");
  stdio.printf("%d %.1f %.1f %d\n", count, ratio, half, ready);
  stdio.printf("%s|%s|%s\n", name, "literal", `tmpl${count}`);
  stdio.printf("%d %d %zu %zu\n", 7, -2147483647, values.length, length);
  let index: i32 = 0;
  while (index < 3) {
    stdio.printf("%s;", `loop ${index}`);
    index = index + 1;
  }
  stdio.printf("\n");
  return 0;
}
