import console from "std/console";

struct Point {
  x: i32;
  y: i32;
}

struct Document {
  title: String;
  revision: i32;
}

struct DocumentStats {
  visits: i32;
}

class SharedDocument {
  title: String;
  revision: i32;
  stats: DocumentStats;

  function refresh(inout this): void {
    this.revision = this.revision + 1;
  }
}

function adjust(inout x: i32, inout y: i32): void {
  x = x + 1;
  y = y - 1;
}

function difference(in left: i32, in right: i32): i32 {
  return left - right;
}

function increment(inout value: i32): void {
  value = value + 1;
}

function main(): i32 {
  let point = Point({ x: 20, y: 22 });

  // Fixed-layout sibling fields are provably disjoint storage.
  adjust(inout point.x, inout point.y);

  const delta = difference(in point.x, in point.y);
  console.log(`point ${point.x},${point.y} delta ${delta}`);

  let document = Document({ title: "Draft", revision: 0 });
  const title = view document.title;
  document.revision = document.revision + 1;
  console.log(`title bytes ${title.byteLength} revision ${document.revision}`);

  // A local class-field view protects the same storage through every known
  // alias while leaving disjoint fixed-layout fields available.
  const shared = new SharedDocument({
    title: "Shared draft",
    revision: 0,
    stats: DocumentStats({ visits: 0 }),
  });
  const alias = shared;
  const sharedTitle = view shared.title;
  alias.revision = alias.revision + 1;
  increment(inout alias.stats.visits);
  console.log(
    `shared bytes ${sharedTitle.byteLength} revision ${alias.revision} visits ${shared.stats.visits}`
  );

  // The title loan ends at its last use, so replacement is legal here.
  alias.title = "Published";
  alias.refresh();
  console.log(`shared ${shared.title} revision ${shared.revision}`);
  return delta;
}
