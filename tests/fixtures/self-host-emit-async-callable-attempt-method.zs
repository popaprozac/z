import { thread } from "std/thread";

struct WorkError {
  code: i32;
}

async function calculate(
  shouldFail: boolean
): i32 throws WorkError on thread.main {
  if (shouldFail) throw WorkError({ code: 41 });
  return 42;
}

type Operation = async (
  shouldFail: boolean
) => Result<i32, WorkError> on thread.main;

function createOperation(): Operation on thread.main {
  return async (
    shouldFail: boolean
  ): Result<i32, WorkError> => attempt await calculate(shouldFail);
}

async function main(): i32 on thread.main {
  const operation = createOperation();
  const result = await operation(true);
  return match (result) {
    success(_) => 1;
    failure(error) => error.code - 41;
  };
}
