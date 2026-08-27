import { thread } from "std/thread";

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
  register("notes", MetadataService());
  return 0;
}
