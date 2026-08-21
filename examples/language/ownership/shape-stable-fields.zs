import console from "std/console";

struct Point {
  x: i32;
  y: i32;
}

struct Document {
  title: String;
  revision: i32;
}

function adjust(inout x: i32, inout y: i32): void {
  x = x + 1;
  y = y - 1;
}

function difference(in left: i32, in right: i32): i32 {
  return left - right;
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
  return delta;
}
