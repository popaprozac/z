// Plain value structs can live in task frames and cross await boundaries.

struct NetworkError {
  code: i32;
}

struct User {
  id: i32;
}

async function loadUser(id: i32): User throws NetworkError {
  return User({ id });
}

async function failUser(): User throws NetworkError {
  throw NetworkError({ code: 7 });
}

async function copyUser(user: User): User {
  return user;
}

async function main(): i32 throws NetworkError {
  const observed = attempt await failUser();
  const user = try await loadUser(0);
  const copied = await copyUser(user);
  return copied.id;
}
