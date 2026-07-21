import console from "std/console";

struct Resource {
  id: i32;

  deinit {
    console.log(`released resource ${this.id}`);
  }
}

class Session {
  id: i32;

  deinit {
    console.log(`released session ${this.id}`);
  }
}

enum ResourceState {
  ready Resource,
  empty,
}

enum SessionOption {
  some Session,
  none,
}

struct Container {
  state: ResourceState;
}

function consume(state: ResourceState): i32 {
  return match (state) {
    ready(resource) => resource.id;
    empty => -1;
  };
}

function inspect(in state: ResourceState): i32 {
  console.log(`captured ${state}`);
  return 42;
}

function main(): i32 {
  const resource = Resource({ id: 40 });
  const state = ResourceState.ready(resource);
  const consumed = consume(state);

  const session = new Session({ id: 7 });
  const option = SessionOption.some(session);
  const observed = match (option) {
    some(value) => value.id;
    none => -1;
  };
  const abandoned = SessionOption.some(session);

  const nested = Container({
    state: ResourceState.ready(Resource({ id: 41 })),
  });

  const captured = ResourceState.ready(Resource({ id: 42 }));
  const reader: () => i32 = move (): i32 => inspect(captured);
  const capturedValue = reader();

  if (consumed == 40 && observed == 7 && capturedValue == 42) {
    return 0;
  }
  return 1;
}
