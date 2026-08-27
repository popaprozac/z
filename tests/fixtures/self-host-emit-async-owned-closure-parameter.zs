readonly class Resource {
  readonly value: i32;
}

async function consume(resource: Resource): i32 {
  return resource.value;
}

type Operation = async (resource: Resource) => i32;

function createOperation(): Operation {
  const operation: Operation = async (
    resource: Resource
  ): i32 => await consume(move resource);
  return move operation;
}

async function main(): i32 {
  const original = new Resource({ value: 42 });
  const retained = original;
  const operation = createOperation();
  const observed = await operation(move retained);
  if (observed != 42) return 1;
  return original.value == 42 ? 0 : 2;
}
