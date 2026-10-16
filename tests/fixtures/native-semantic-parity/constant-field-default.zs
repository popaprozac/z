import console from "std/console";

// A struct field's default names a module constant: the native compiler
// resolves it as it would in a function body.
const LIMIT: u32 = 4096;
const LABEL: String = "poll";

struct Counter {
  name: u32;
  left: u32 = LIMIT;
  step: u32 = LIMIT / 4;
  ready: boolean = true;
}

function main(): i32 {
  const counter = Counter({ name: 1 });
  const custom = Counter({ name: 2, left: 7 });
  console.log(LABEL, counter.left, counter.step, custom.left, custom.step, counter.ready);
  return 0;
}
