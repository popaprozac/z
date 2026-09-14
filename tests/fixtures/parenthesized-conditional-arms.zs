function choose(factory: boolean, ready: boolean, veto: boolean, denied: boolean): i32 {
  return factory ? (ready ? 2 : veto ? 1 : 0) : denied ? 0 : (ready ? 1 : 3);
}

function main(): i32 {
  if (choose(true, true, false, false) != 2) return 1;
  if (choose(true, false, true, false) != 1) return 2;
  if (choose(false, false, false, false) != 3) return 3;
  const grouped = true ? (20 + 22) : 0;
  const nested = false ? ((1)) : (grouped);
  if (nested != 42) return 4;
  const typed = (value: i32): i32 => value + 1;
  const throwing = (value: i32): i32 throws i32 => {
    if (value == 0) throw 1;
    return value;
  };
  const functionResult = (): (value: i32) => i32 => (value: i32): i32 => value + 2;
  if (typed(41) != 42) return 5;
  const observed = match (attempt throwing(42)) { success(value) => value; failure(_) => 0; };
  if (observed != 42) return 6;
  const add = functionResult();
  if (add(40) != 42) return 7;
  return 0;
}
