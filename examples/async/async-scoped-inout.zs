import console from "std/console";
import { delay } from "std/time";

struct ImportProgress {
  completed: i32;

  function advance(inout this, amount: i32): void {
    this.completed = this.completed + amount;
  }
}

async function importBatchAfter(inout progress: ImportProgress, count: i32): void {
  await delay(1);
  progress.advance(count);
}

async function main(): i32 {
  let progress = ImportProgress({ completed: 40 });

  async scope {
    const batch = spawn importBatchAfter(inout progress, 1);
    console.log("import batch started");

    await batch;
    progress.advance(1);
  }

  console.log(`imported=${progress.completed}`);
  return progress.completed - 42;
}
