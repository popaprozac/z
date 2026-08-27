import { thread } from "std/thread";

export struct MetadataService {
  function count(): u64 on thread.main {
    return 1;
  }
}

export function register(name: String, service: MetadataService): void {
  if (name == "") return;
  service.count();
}

function main(): i32 {
  register("notes", MetadataService());
  return 0;
}
