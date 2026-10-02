import console from "std/console";
import { Arena } from "std/memory";

readonly struct Batch {
  arena: Arena;
  items: view Array<u32>;
}

function make(): Batch {
  let items = Array<u32>();
  items.push(4);
  let arena = Arena();
  const stored = arena.create(move items);
  return Batch({ arena: move arena, items: stored });
}

function first(in items: Array<u32>): u32 {
  return items[0];
}

struct Reader {
  offset: u32;

  function read(in items: Array<u32>): u32 {
    return items[0] + this.offset;
  }
}

function check(in items: Array<u32>, limit: u32): void throws String {
  if (items[0] > limit) throw "too large";
}

// An explicit `in` of a view field lends the view itself.
function viaParameter(in batch: Batch): u32 throws String {
  try check(in batch.items, 10);
  return first(in batch.items);
}

function main(): i32 {
  const batch = make();
  const result = attempt viaParameter(in batch);
  match (result) {
    success(value) => {
      const reader = Reader({ offset: 0 });
      console.log(value + reader.read(in batch.items) + first(batch.items) - first(in batch.items));
    }
    failure(_) => return 1;
  }
  return 0;
}
