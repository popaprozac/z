import console from "std/console";
import { Arena } from "std/memory";

struct ParsedRecord {
  id: i32;
  line: i32;

  deinit {
    console.log(`released record ${this.id}`);
  }
}

function describe(in record: ParsedRecord): i32 {
  console.log(`record ${record.id} came from line ${record.line}`);
  return record.id;
}

function main(): i32 {
  let scratch = Arena({ initialCapacity: 65536 });

  const header = scratch.create(ParsedRecord({ id: 20, line: 1 }));
  const body = scratch.create(ParsedRecord({ id: 22, line: 8 }));
  const total = describe(header) + describe(body);

  // reset is legal after the last use of both views. Cleanup runs newest first.
  scratch.reset();

  const footer = scratch.create(ParsedRecord({ id: total, line: 12 }));
  return describe(footer) - 42;
}
