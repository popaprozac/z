import console from "std/console";
import { thread } from "std/thread";

struct WorkError {
  code: i32;
  message: String;
}

function calculate(value: i32, fail: boolean): i32 throws WorkError {
  if (fail) {
    throw WorkError({ code: 7, message: "calculation failed" });
  }
  return value;
}

async function propagateFailure(): i32 throws WorkError {
  const task = thread.spawn((): i32 throws WorkError => {
    return try calculate(0, true);
  });
  return try await task;
}

async function main(): i32 throws WorkError {
  const shouldFail = true;
  const failedTask = thread.spawn(move (): i32 throws WorkError => {
    const value = try calculate(40, shouldFail);
    return value;
  });
  const observed = attempt await failedTask;
  const recovered = match (in observed) {
    success(value) => value;
    failure(error) => error.code;
  };

  const successfulTask = thread.spawn((): i32 throws WorkError => {
    const observed = attempt calculate(35, false);
    return match (in observed) {
      success(value) => value;
      failure(error) => -error.code;
    };
  });
  const value = try await successfulTask;
  const propagated = attempt await propagateFailure();
  const propagatedCode = match (in propagated) {
    success(value) => value;
    failure(error) => error.code;
  };
  console.log(`worker failure=${recovered}, propagated=${propagatedCode}, success=${value}`);
  return recovered + propagatedCode + value - 49;
}
