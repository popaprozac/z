async function finish(value: i32): i32 {
  return value;
}

async function route(value: i32): i32 {
  if (value < 0) return -1;
  const permission = value == 0 ? "read" : "write";
  if (permission == "read") return await finish(40);
  const offset = 2;
  if (value == 1) return 41;
  return await finish(value + offset);
}

async function main(): i32 {
  const result = await route(2);
  return result == 4 ? 0 : 1;
}
