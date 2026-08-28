import { PublicFailure, createWorker } from "./api.zs";
import console from "std/console";

struct FailureContext {
  failure: PublicFailure;
}

function inspect(in context: FailureContext): void {
  console.log(`nested ${context.failure.code}: ${context.failure.message}`);
}

function main(): i32 {
  let ownedFailure: PublicFailure =
    PublicFailure({ code: 7, message: "nested failure" });
  const movedFailure = move ownedFailure;
  const context = FailureContext({
    failure: move movedFailure,
  });
  inspect(in context);
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
