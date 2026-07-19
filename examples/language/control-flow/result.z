import stdio from "stdio.h";

struct User {
  id: i32;
}

struct UserError {
  code: i32;
}

function findUser(id: i32): User throws UserError {
  return User({ id: id });
}

function failUser(code: i32): User throws UserError {
  throw UserError({ code: code });
}

function main(): i32 {
  const found = attempt findUser(42);
  match (found) {
    success(user) => stdio.printf("found=%d\n", user.id);
    failure(error) => stdio.printf("error=%d\n", error.code);
  }

  const failed = attempt failUser(7);
  match (failed) {
    success(user) => stdio.printf("found=%d\n", user.id);
    failure(error) => stdio.printf("error=%d\n", error.code);
  }

  return 0;
}
