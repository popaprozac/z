import { thread } from "std/thread";
import { sleep } from "std/time";
import native from "../../tests/fixtures/move-only.hpp";

struct WorkerError {
  evidence: native.zcpp.UniqueValue;
}

async function observeFailure(): i32 {
  const measurement = native.zcpp.UniqueValue(42);
  const calculation = thread.spawn(move (): i32 throws WorkerError => {
    if (measurement.value() == 42) {
      throw WorkerError({ evidence: native.zcpp.UniqueValue(7) });
    }
    return 0;
  });

  const observed = attempt await calculation;
  return match (in observed) {
    success(value) => value;
    failure(error) => error.evidence.value();
  };
}

async function discardCompletedFailure(): i32 {
  const calculation = thread.spawn((): i32 throws WorkerError => {
    throw WorkerError({ evidence: native.zcpp.UniqueValue(9) });
  });
  sleep(20);
  await calculation.cancel();
  return native.zcpp.unique_live();
}

async function main(): i32 {
  const errorCode = await observeFailure();
  const liveAfterDiscard = await discardCompletedFailure();
  // Captures, observed errors, and explicitly discarded errors are all gone.
  return errorCode - 7 + liveAfterDiscard + native.zcpp.unique_live();
}
