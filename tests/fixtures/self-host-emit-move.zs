struct Resource {
  id: i32;

  deinit {}
}

function inspect(resource: Resource): i32 {
  return resource.id;
}

function relay(resource: Resource): i32 {
  return inspect(move resource);
}

function main(): i32 {
  return relay(Resource({ id: 42 }));
}
