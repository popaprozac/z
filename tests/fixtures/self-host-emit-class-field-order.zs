class Session {
  id: i32;
  title: String;
}

function main(): i32 {
  const session = new Session({
    title: "Draft",
    id: 42,
  });
  if (session.title != "Draft") return 1;
  return session.id - 42;
}
