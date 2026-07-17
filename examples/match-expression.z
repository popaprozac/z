import stdio from "stdio.h";

struct User {
  id: i32;
}

struct UserError {
  code: i32;
}

enum UserResult {
  success User,
  failure UserError,
}

function code(result: UserResult): i32 {
  return match (result) {
    success(user) => user.id;
    failure(error) => error.code;
  };
}

function userId(result: UserResult): i32 throws UserError {
  return match (result) {
    success(user) => {
      const adjusted = user.id + 1;
      select adjusted;
    }
    failure(error) => throw error;
  };
}

function main(): i32 {
  const found = UserResult.success(User({ id: 41 }));
  stdio.printf("code=%d\n", code(found));

  const direct = match (found) {
    success(user) => user.id;
    failure(error) => error.code;
  };
  stdio.printf("direct=%d\n", direct);

  const result = attempt userId(found);
  match (result) {
    success(value) => stdio.printf("selected=%d\n", value);
    failure(error) => stdio.printf("error=%d\n", error.code);
  }
  return 0;
}
