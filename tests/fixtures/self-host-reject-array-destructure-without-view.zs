struct Document {
  title: String;
}

function main(): i32 {
  const documents = Array<Document>(Document({ title: "draft" }));
  const [current] = documents;
  return i32(current.title.byteLength);
}
