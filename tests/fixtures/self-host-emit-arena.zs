import console from "std/console";
import { Arena as Region } from "std/memory";

class ScratchIdentity {
  readonly id: i32;

  deinit {
    console.log(`released identity ${this.id}`);
  }
}

struct ScratchBatch {
  label: String;
  values: Array<i32>;
  identity: ScratchIdentity;

  deinit {
    console.log(`released ${this.label}`);
  }
}

function finish(region: Region): void {
  // The owned parameter performs the region's scope cleanup.
}

function main(): i32 {
  let scratch = Region({ initialCapacity: 128 });
  let values = Array<i32>();
  values.push(20);
  values.push(22);
  const batch = scratch.create(ScratchBatch({
    label: "compiler scratch",
    values,
    identity: new ScratchIdentity({ id: 7 }),
  }));
  const answer = batch.values[0] + batch.values[1];
  console.log(`${batch.label}: ${answer}`);
  finish(scratch);
  return answer - 42;
}
