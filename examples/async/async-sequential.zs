// Sequential await executes each operation before the enclosing task continues.

async function fetchValue(value: i32): i32 {
  return value;
}

async function main(): i32 {
  const first = await fetchValue(20);
  const second = await fetchValue(22);
  return first == 20 && second == 22 ? 0 : 1;
}
