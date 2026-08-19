struct Record {
  name: String;
  revision: i32;
}

function main(): i32 {
  const record = Record({ name: "draft", revision: 42 });
  const { name } = move record;
  if (name != "draft") return 1;
  return record.revision;
}
