import { thread } from "std/thread";

export trait MetadataSource<T> {
  function read(inout this): T;
}

struct MetadataCounter implements MetadataSource<i32> {
  value: i32;

  function read(inout this): i32 {
    return this.value;
  }
}

export struct MetadataService {
  function count(): u64 on thread.main {
    return 1;
  }
}

export function register(
  name: String,
  service: MetadataService
): void on thread.main {
  if (name == "") return;
  service.count();
}

function main(): i32 on thread.main {
  let counter = MetadataCounter({ value: 1 });
  if (counter.read() != 1) return 1;
  register("notes", MetadataService());
  return 0;
}
