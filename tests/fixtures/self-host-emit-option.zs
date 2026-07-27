struct Resource {
  id: i32;

  deinit {}
}

function present(value: i32): Option<i32> {
  return Option<i32>.some(value);
}

function absent(): Option<i32> {
  return Option<i32>.none;
}

function inspect(option: Option<i32>): i32 {
  return match (option) {
    some(value) => value;
    none => 0;
  };
}

function resource(value: i32): Option<Resource> {
  return Option<Resource>.some(Resource({ id: value }));
}

function inspectResource(option: Option<Resource>): i32 {
  return match (option) {
    some(resource) => resource.id;
    none => 0;
  };
}

function discardResource(): i32 {
  const held: Option<Resource> = resource(0);
  return 0;
}

function main(): i32 {
  return inspectResource(resource(42))
    + inspect(present(0))
    + inspect(absent())
    + discardResource();
}
