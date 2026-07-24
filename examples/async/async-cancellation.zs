import console from "std/console";

struct CancelledWork {
  id: i32;

  deinit {
    console.log(`released cancellation work ${this.id}`);
  }
}

async function finish(work: CancelledWork): void {
  return;
}

async function sibling(work: CancelledWork): void {
  await finish(CancelledWork({ id: 2 }));

  // The propagated sibling failure cancels this task before this task runs.
  task finish(CancelledWork({ id: 3 }));
  return;
}

async function fail(): i32 throws i32 {
  throw 7;
}

async function main(): i32 throws i32 {
  const failure = task fail();
  task sibling(CancelledWork({ id: 1 }));
  return try await failure;
}
