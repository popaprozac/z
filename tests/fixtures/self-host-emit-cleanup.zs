struct Resource {
  id: i32;

  deinit {}
}

function inspect(resource: Resource): i32 {
  return resource.id;
}

function main(): i32 {
  return inspect(Resource({ id: 42 }));
}
