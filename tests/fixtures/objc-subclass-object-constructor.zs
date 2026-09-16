import native from "./objc-subclass.h";
import { thread } from "std/thread";

class ObjectOwner extends native.ZSubclassFixture on thread.main {
  private resource: native.ZSubclassStoredResource;
  constructor(resource: native.ZSubclassStoredResource) {
    super.initWithValue(resource.storedValue);
    this.resource = resource;
  }
  override function value(): i32 as "value" { return this.resource.value(); }
}

function makeOwner(): ObjectOwner on thread.main {
  const resource = native.z_subclass_stored_resource(42);
  const owner = new ObjectOwner(resource);
  // Construction retains an alias, never consumes the caller's reference.
  resource.touch();
  return owner;
}

function exercise(): i32 on thread.main {
  const owner = makeOwner();
  if (native.z_subclass_stored_live() != 1) return 1;
  if (owner.readVirtualValue() != 42) return 2;
  return 0;
}

function loopLifetimes(): i32 on thread.main {
  let index = 0;
  while (index < 3) {
    index = index + 1;
    if (index == 1) continue;
    const resource = native.z_subclass_stored_resource(index);
    if (index == 2) continue;
    resource.touch();
  }
  const values = Array<i32>(1, 2, 3);
  for (const value of values) {
    if (value == 1) continue;
    const resource = native.z_subclass_stored_resource(value);
    if (value == 2) continue;
    resource.touch();
  }
  if (native.z_subclass_stored_live() != 0) return 5;
  return 0;
}

function main(): i32 on thread.main {
  const result = exercise();
  if (result != 0) return result;
  if (native.z_subclass_stored_live() != 0) return 3;
  if (native.z_subclass_stored_created() != native.z_subclass_stored_destroyed()) return 4;
  return loopLifetimes();
}
