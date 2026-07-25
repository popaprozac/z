import console from "std/console";
import { delay } from "std/time";

struct RequestError {
  code: i32;
  message: String;

  deinit {
    console.log(`released request error ${this.code}`);
  }
}

function errorMessage(code: i32): String {
  return `request ${code} failed`;
}

async function failAfter(code: i32, milliseconds: u64): i32 throws RequestError {
  const message = errorMessage(code);
  await delay(milliseconds);
  throw RequestError({
    code,
    message,
  });
}

async function relayFailure(code: i32): i32 throws RequestError {
  return try await failAfter(code, 1);
}

async function main(): i32 {
  const direct = attempt await failAfter(1, 1);
  const directCode = match (direct) {
    success(value) => value;
    failure(error) => error.code;
  };

  const relayed = attempt await relayFailure(2);
  const relayedCode = match (relayed) {
    success(value) => value;
    failure(error) => error.code;
  };

  const completed = task failAfter(3, 1);
  await delay(5);
  await completed.cancel();

  const cancelled = task failAfter(4, 1000);
  await delay(1);
  await cancelled.cancel();

  return directCode + relayedCode - 3;
}
