// Typed async outcomes use throw, attempt await, and try await.

async function succeed(value: i32): i32 throws i32 {
  return value;
}

async function fail(): i32 throws i32 {
  throw 7;
}

async function finish(): void throws i32 {
  return;
}

async function main(): i32 throws i32 {
  const observed = attempt await fail();
  try await finish();
  const answer = try await succeed(0);
  return answer;
}
