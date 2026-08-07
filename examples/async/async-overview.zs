// An overview of executable tasks, typed outcomes, joins, and placed suspension.
// Run `bun run z run examples/async/async-overview.zs`.

import console from "std/console";

struct NetworkError {
  code: i32;
}

async function fetchValue(id: i32): i32 throws NetworkError {
  return id;
}

async function warmValue(id: i32): void {
  console.log(`warmed ${id}`);
}

async function isExpected(value: i32): boolean {
  return value == 42;
}

async function main(): i32 throws NetworkError {
  const baseline = match (attempt await fetchValue(0)) {
    success(value) => value;
    failure(error) => -error.code;
  };
  const first = try await fetchValue(20);
  const secondTask = task fetchValue(22);
  const second = try await secondTask;

  // This narrower scope joins both children before the following statement.
  async scope {
    task warmValue(1);
    task warmValue(2);
  }

  console.log("warm batch complete");
  if (await isExpected(baseline + first + second)) {
    return 0;
  }
  return 1;
}
