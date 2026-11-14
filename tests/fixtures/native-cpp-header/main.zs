import console from "std/console";
import scaling from "./scaling.hpp";

struct Reading {
  label: String;
  value: i32;
}

function describe(in reading: Reading): String {
  return `${reading.label}=${reading.value}`;
}

function main(): i32 {
  const total = scaling.scaled_total(7);
  const text = describe(Reading({ value: total, label: "total" }));
  console.log(text);
  return total - 42;
}
