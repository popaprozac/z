import console from "std/console";

struct Bounds {
  min: i32;
  max: i32;

  static function normalized(left: i32, right: i32): Bounds {
    if (left <= right) {
      return Bounds({ min: left, max: right });
    }
    return Bounds({ min: right, max: left });
  }
}

struct InvalidSession {
  code: i32;
}

class Session {
  private id: i32;

  constructor(id: i32) {
    this.id = id;
  }

  private static function normalizedId(id: i32): i32 {
    if (id < 0) { return 0; }
    return id;
  }

  static function create(id: i32): Session {
    return new Session(Session.normalizedId(id));
  }

  static function checked(id: i32): Session throws InvalidSession {
    if (id < 0) { throw InvalidSession({ code: id }); }
    return new Session(id);
  }

  function identifier(): i32 {
    return this.id;
  }
}

function main(): i32 {
  const bounds = Bounds.normalized(9, 2);
  const session = Session.create(-4);
  const checked = attempt Session.checked(42);
  const checkedId = match (checked) {
    success(value) => value.identifier();
    failure(error) => error.code;
  };
  console.log(`bounds=${bounds}, session=${session.identifier()}, checked=${checkedId}`);
  return 0;
}
