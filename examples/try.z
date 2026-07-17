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

function userId(id: i32): i32 throws UserError {
  const user = try findUser(id);
  return user.id;
}

function forwardedUser(id: i32): User throws UserError {
  return try findUser(id);
}

function failedId(code: i32): i32 throws UserError {
  const user = try failUser(code);
  return user.id;
}

function main(): i32 {
  const found = attempt userId(42);
  match (found) {
    success(id) => stdio.printf("id=%d\n", id);
    failure(error) => stdio.printf("error=%d\n", error.code);
  }

  const forwarded = attempt forwardedUser(9);
  match (forwarded) {
    success(user) => stdio.printf("forwarded=%d\n", user.id);
    failure(error) => stdio.printf("error=%d\n", error.code);
  }

  const failed = attempt failedId(7);
  match (failed) {
    success(id) => stdio.printf("id=%d\n", id);
    failure(error) => stdio.printf("error=%d\n", error.code);
  }

  return 0;
}
