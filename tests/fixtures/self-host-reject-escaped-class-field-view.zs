class Document {
  title: String;
  revision: i32;
}

function publish(document: Document): void {}

function main(): i32 {
  const document = new Document({ title: "Draft", revision: 0 });
  publish(document);
  const title = view document.title;
  return i32(title.byteLength);
}
