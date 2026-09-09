struct Resource {
  id: i32;

  deinit {}
}

struct Batch {
  first: Resource;
  second: Resource;
}

function split(batch: Batch): void {
  const { first, second } = move batch;
}

function main(): i32 {
  return 0;
}
