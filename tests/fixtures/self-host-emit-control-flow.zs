function factorial(limit: i32): i32 {
  let current: i32 = 1;
  let result: i32 = 1;
  while (current <= limit) {
    result = result * current;
    current = current + 1;
  }
  return result;
}

function main(): i32 {
  const answer: i32 = factorial(5);
  if (answer == 120) return 0;
  return 1;
}
