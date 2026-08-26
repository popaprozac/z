struct Resource {
  id: i32;

  deinit {}
}

enum Value {
  resource Resource,
  number i32,
  empty,
}

class Session {
  id: i32;
}

function consume(value: Value): i32 {
  return match (value) {
    number(number) => number;
    _ => -1;
  };
}

function inspect(in value: Value): i32 {
  return match (in value) {
    resource(resource) => resource.id;
    _ => 0;
  };
}

function discardOption(option: Option<Session>): i32 {
  return match (option) {
    none => 0;
    _ => 1;
  };
}

function main(): i32 {
  const owned = Value.resource(Resource({ id: 42 }));
  const observed = Value.resource(Resource({ id: 41 }));
  const option = Option.some(new Session({ id: 1 }));
  return consume(owned) + inspect(observed) + discardOption(option) - 41;
}
