export struct MetadataService {
  function count(): u64 {
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
