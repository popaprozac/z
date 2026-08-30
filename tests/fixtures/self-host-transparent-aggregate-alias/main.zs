import {
  NativeFailure,
  PublicFailure,
  createWorker,
} from "./api.zs";
import console from "std/console";

struct FailureContext {
  failure: PublicFailure;
}

function inspect(in context: FailureContext): void {
  console.log(`nested ${context.failure.code}: ${context.failure.message}`);
}

function inspectSameNamedAlias(in failure: NativeFailure): void {
  console.log(`same-name ${failure.code}: ${failure.message}`);
}

function main(): i32 {
  const failures = Array<PublicFailure>(
    PublicFailure({ code: 8, message: "generic nested failure" })
  );
  if (failures[0].code != 8) return 1;
  let ownedFailure: PublicFailure =
    PublicFailure({ code: 7, message: "nested failure" });
  const movedFailure = move ownedFailure;
  const context = FailureContext({
    failure: move movedFailure,
  });
  inspect(in context);
  inspectSameNamedAlias(in context.failure);
  const worker = createWorker();
  const result = attempt worker.perform();
  return match (result) {
    success(value) => value;
    failure(error) => {
      console.log(`failure ${error.code}: ${error.message}`);
      select 0;
    }
  };
}
