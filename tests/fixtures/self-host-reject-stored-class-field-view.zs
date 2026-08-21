class Document {
  title: String;
  revision: i32;
}

struct Holder {
  document: Document;
}

function main(): i32 {
  const document = new Document({ title: "Draft", revision: 0 });
  const holder = Holder({ document });
  const title = view document.title;
  return i32(title.byteLength) + holder.document.revision;
}
