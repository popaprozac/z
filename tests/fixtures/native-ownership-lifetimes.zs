import console from "std/console";
struct Resource {
  id: i32;
  label: String = "";
  deinit { console.log(`drop=${this.id}`); }
}
class Handle {
  readonly id: i32;
  constructor(id: i32) { this.id = id; }
}
function make(id: i32): Resource { return Resource({ id: id, label: `heap-${id}` }); }
function consume(value: Resource): i32 { return value.id; }
function fill(id: i32, out resource: Resource): void { resource = make(id); }
function forward(id: i32, out resource: Resource): void { fill(id, out resource); }
function refill(id: i32, inout resource: Resource): void { fill(id, out resource); }
function fillHandle(id: i32, out handle: Handle): void { handle = new Handle(id); }
function main(): i32 {
  let plain: Resource;
  plain = make(1);
  let cycled: Resource;
  cycled = make(2);
  const seen = consume(cycled);
  cycled = make(3);
  let viaOut: Resource;
  fill(4, out viaOut);
  fill(5, out viaOut);
  let forwarded: Resource;
  forward(6, out forwarded);
  let refilled = make(7);
  refill(8, inout refilled);
  let handle: Handle;
  fillHandle(9, out handle);
  fillHandle(10, out handle);
  console.log(`seen=${seen} ${plain.id} ${cycled.id} ${viaOut.id} ${forwarded.id} ${refilled.id} ${handle.id}`);
  return 0;
}
