struct Document {
  title: String;
}

function main(): i32 {
  let documents = Array<Document>(Document({ title: "draft" }));
  const [current] = view documents;
  documents.push(Document({ title: "published" }));
  return i32(current.title.byteLength);
}
