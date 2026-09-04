struct Resource {
  id: i32;

  deinit {}
}

struct Note {
  title: String;
}

class User {
  id: i32;
}

enum Selection {
  present,
  absent,
}

function present(value: i32): Option<i32> {
  return Option<i32>.some(value);
}

function absent(): Option<i32> {
  return Option<i32>.none;
}

function optionFromMatch(selection: Selection): Option<i32> {
  return match (in selection) {
    present => Option.some(42);
    absent => Option.none;
  };
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
  const held = resource(0);
  return 0;
}

function scalarValue(in option: Option<i32>): i32 {
  return match (option) {
    some(value) => value;
    none => -1;
  };
}

function titleLength(in option: Option<Note>): usize {
  return match (option) {
    some(note) => note.title.byteLength;
    none => 0;
  };
}

function missingNote(): Option<Note> {
  return Option.none;
}

function userId(in option: Option<User>): i32 {
  return match (option) {
    some(user) => user.id;
    none => -1;
  };
}

function conditionalText(present: boolean): Option<String> {
  const value: Option<String> = present
    ? Option.some("z")
    : Option.none;
  return value;
}

function nativeOptionProbe(): i32 {
  const scalar = Option.some(42);
  const noScalar: Option<i32> = Option.none;
  if (scalarValue(scalar) != 42 || scalarValue(noScalar) != -1) {
    return 1;
  }

  const note = Note({ title: `note ${42}` });
  const storedNote = Option.some(note);
  if (titleLength(storedNote) != 7) {
    return 2;
  }

  const user = new User({ id: 42 });
  const storedUser = Option.some(user);
  const explicitUser = Option<User>.some(user);
  if (
    user.id != 42
    || userId(storedUser) != 42
    || userId(explicitUser) != 42
  ) {
    return 3;
  }
  const conditional = conditionalText(true);
  const conditionalLength = match (conditional) {
    some(value) => value.byteLength;
    none => usize(0);
  };
  if (conditionalLength != 1) return 6;
  const missing = missingNote();
  if (titleLength(in missing) != 0) return 7;

  const noUser: Option<User> = Option.none;
  if (userId(noUser) != -1) {
    return 4;
  }
  if (
    inspect(optionFromMatch(Selection.present)) != 42
    || inspect(optionFromMatch(Selection.absent)) != 0
  ) {
    return 5;
  }
  return 0;
}

function main(): i32 {
  return inspectResource(resource(42))
    + inspect(present(0))
    + inspect(absent())
    + discardResource()
    + nativeOptionProbe();
}
