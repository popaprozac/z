class Session {
  private id: i32;
  public name: String;

  constructor(id: i32, name: String) {
    this.id = id;
    this.name = name;
  }

  function identifier(): i32 {
    return this.id;
  }
}

struct InvalidSession {
  code: i32;
}

function checkedIdentifier(id: i32): i32 throws InvalidSession {
  if (id < 0) {
    throw InvalidSession({ code: id });
  }
  return id;
}

class CheckedSession {
  private name: String;
  private id: i32;

  constructor(name: String, id: i32) throws InvalidSession {
    this.name = name;
    this.id = try checkedIdentifier(id);
  }

  function identifier(): i32 {
    return this.id;
  }
}

function main(): i32 {
  const session = new Session(42, "primary");
  const failed = attempt new CheckedSession("invalid", -7);
  const failureCode = match (failed) {
    success(value) => value.identifier();
    failure(error) => error.code;
  };
  return session.identifier() + failureCode - 35;
}
