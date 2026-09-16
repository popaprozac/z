import native from "objc-array-pop.h";

function fill(inout objects: Array<native.ZArrayPopOwner>): void {
  const owner = native.ZArrayPopOwner.alloc().init();
  owner.title = "Draft";
  objects.push(owner);
}

function main(): i32 {
  native.z_array_pop_watch_cleanup();
  let objects = Array<native.ZArrayPopOwner>();
  fill(inout objects);
  objects[0] = objects[0];
  objects[0].title = "Draft";
  const removed = objects.pop();
  objects.clear();
  fill(inout objects);
  objects.clear();
  fill(inout objects);
  objects.pop(); // An ignored native reference follows ordinary ARC cleanup.
  fill(inout objects);
  { const unused = objects.pop(); }
  return match (removed) {
    some(owner) => {
      const title: String = owner.title;
      select title == "Draft" ? 0 : 1;
    }
    none => 2;
  };
}
