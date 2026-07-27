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

function inspect(state: ResourceState): i32 {
  match (state) {
    ready(resource) => return resource.id;
    empty => return 0;
  }
}

function inspectValue(state: ResourceState): i32 {
  return match (state) {
    ready(resource) => resource.id;
    empty => 0;
  };
}

function inspectIf(
  state: ResourceState,
  inspectNow: boolean
): i32 {
  if (inspectNow) {
    match (state) {
      ready(resource) => return resource.id;
      empty => return 0;
    }
  }
  return 0;
}

function observe(): i32 {
  const state: ResourceState = ResourceState.ready(Resource({ id: 41 }));
  const container: Container = Container({
    state: ResourceState.ready(Resource({ id: 1 })),
  });
  return inspectValue(ResourceState.ready(Resource({ id: 42 })));
}

function main(): i32 {
  return observe()
    + inspectIf(ResourceState.ready(Resource({ id: 0 })), false);
}
