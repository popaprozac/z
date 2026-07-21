import { puts, printf as print } from "stdio.h";

function main(): i32 {
  puts("selective C imports");
  print("answer=%d\n", 42);
  return 0;
}
