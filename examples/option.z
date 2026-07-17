class User {
  id: i32;
}

function userId(in option: Option<User>): i32 {
  return match (option) {
    some(user) => user.id;
    none => -1;
  };
}

function main(): i32 {
  const user = new User({ id: 42 });
  const present = Option.some(user);
  const absent: Option<User> = Option.none;

  if (userId(present) == 42 && userId(absent) == -1) {
    return 0;
  }
  return 1;
}
