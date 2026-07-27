struct Resource {
  id: i32;

  deinit {}
}

function inspect(resource: Resource): i32 {
  return resource.id;
}

function observeLocal(): i32 {
  const resource: Resource = Resource({ id: 40 });
  return resource.id + 2;
}

function moveLocal(): i32 {
  const resource: Resource = Resource({ id: 42 });
  return inspect(move resource);
}

function main(): i32 {
  return observeLocal() + moveLocal() - 42;
}
