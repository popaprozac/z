struct Resource {
  id: i32;

  deinit {}
}

struct Registry {
  values: Array<Resource>;

  function revokeAll(inout this): void {
    this.values.clear();
  }
}

function main(): i32 {
  let registry = Registry({
    values: Array<Resource>(Resource({ id: 1 }), Resource({ id: 2 })),
  });
  const capacity: usize = registry.values.capacity;
  registry.revokeAll();
  if (registry.values.length != 0 || registry.values.capacity != capacity) return 1;
  registry.values.push(Resource({ id: 3 }));
  return registry.values.length == 1 ? 0 : 2;
}
