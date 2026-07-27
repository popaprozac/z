struct Container {
  state: ResourceState;
}

enum ResourceState {
  ready Resource,
  empty,
}

struct Resource {
  id: i32;

  deinit {}
}

function observe(): i32 {
  const state: ResourceState = ResourceState.ready(Resource({ id: 41 }));
  const container: Container = Container({
    state: ResourceState.ready(Resource({ id: 1 })),
  });
  return 42;
}

function main(): i32 {
  return observe();
}
