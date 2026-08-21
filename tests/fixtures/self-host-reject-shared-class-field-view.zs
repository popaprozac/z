class Document {
  title: String;
  revision: i32;
}

function currentApplication(): Document {
  return new Document({ title: "Shared", revision: 0 });
}

function main(): i32 {
  const document = currentApplication();
  const title = view document.title;
  return i32(title.byteLength);
}
