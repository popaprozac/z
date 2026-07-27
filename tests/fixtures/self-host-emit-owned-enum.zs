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

function inspectLocal(state: ResourceState): i32 {
  const value: i32 = match (state) {
    ready(resource) => resource.id;
    empty => 0;
  };
  return value;
}

function selectResource(state: ResourceState): Resource {
  return match (state) {
    ready(resource) => resource;
    empty => Resource({ id: 0 });
  };
}

function inspectOwnedLocal(): i32 {
  const state: ResourceState = ResourceState.ready(Resource({ id: 42 }));
  const selected: Resource = match (state) {
    ready(resource) => resource;
    empty => Resource({ id: 0 });
  };
  return selected.id;
}

function makeState(id: i32): ResourceState {
  return ResourceState.ready(Resource({ id }));
}

function inspectTemporary(): i32 {
  return match (ResourceState.ready(Resource({ id: 42 }))) {
    ready(resource) => resource.id;
    empty => 0;
  };
}

function inspectCall(): i32 {
  return match (makeState(42)) {
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
  return inspectCall();
}

function main(): i32 {
  return observe()
    + inspectIf(ResourceState.ready(Resource({ id: 0 })), false);
}
