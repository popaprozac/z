struct Document {
  title: String;
}

function load(): Document throws String {
  return Document({ title: "Draft" });
}

function identity<T>(value: T): T {
  return move value;
}

function main(): i32 {
  // The match binding shadows an unrelated outer value. Inference for the
  // subsequent generic call must use the selected arm's lexical environment.
  const value: i32 = 9;
  const document = match (attempt load()) {
    success(value) => value;
    failure(_) => return 1;
  };
  const transferred = identity(move document);
  if (transferred.title != "Draft" || value != 9) return 2;
  return 0;
}
