import console from "std/console";

type Transform = (value: i32) => i32;

function double(value: i32): i32 {
  return value * 2;
}

function apply(in operation: Transform, value: i32): i32 {
  return operation(value);
}

function applyInline(
  in operation: (value: i32) => i32,
  value: i32
): i32 {
  return operation(value);
}

function main(): i32 {
  const direct: Transform = double;
  const offset = 2;
  const add = (value: i32): i32 => value + offset;
  const doubled = apply(in direct, 20);
  const adjusted = add(40);
  const inlineDoubled = applyInline(in direct, 20);

  console.log(
    `doubled=${doubled} adjusted=${adjusted} inline=${inlineDoubled}`
  );
  return doubled + adjusted + inlineDoubled - 122;
}
